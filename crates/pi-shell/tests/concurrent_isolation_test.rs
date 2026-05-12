#[cfg(unix)]
mod tests {
	use std::{
		collections::HashMap,
		path::{Path, PathBuf},
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use pi_shell::{
		ShellExecuteOptions,
		cancel::{AbortReason, CancelToken},
		execute_shell,
		process::{Process, ProcessStatus},
	};
	use tokio::{fs, task::JoinHandle, time};

	fn unique_pid_file(label: &str) -> PathBuf {
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("clock should be after unix epoch")
			.as_nanos();
		std::env::temp_dir().join(format!("pi-shell-{label}-{suffix}.pid"))
	}

	async fn wait_for_pid(path: &Path) -> i32 {
		let text = time::timeout(Duration::from_secs(5), async {
			loop {
				if let Ok(text) = fs::read_to_string(path).await {
					break text;
				}
				time::sleep(Duration::from_millis(50)).await;
			}
		})
		.await
		.expect("pid file should be written");
		text
			.trim()
			.parse::<i32>()
			.expect("pid file should contain an integer pid")
	}

	fn spawn_shell(
		pid_file: &Path,
		cancel_token: CancelToken,
	) -> JoinHandle<anyhow::Result<pi_shell::ShellExecuteResult>> {
		tokio::spawn(execute_shell(
			ShellExecuteOptions {
				command: "sh -c 'sleep 1000 & echo $! > \"$PID_FILE\"; wait'".to_string(),
				env: Some(HashMap::from([("PID_FILE".to_string(), pid_file.display().to_string())])),
				..Default::default()
			},
			None,
			cancel_token,
		))
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn cancelling_one_execute_shell_does_not_kill_the_other() {
		let pid_file_a = unique_pid_file("concurrent-a");
		let pid_file_b = unique_pid_file("concurrent-b");
		let _ = fs::remove_file(&pid_file_a).await;
		let _ = fs::remove_file(&pid_file_b).await;

		let mut cancel_a = CancelToken::default();
		let abort_a = cancel_a.emplace_abort_token();
		let mut cancel_b = CancelToken::default();
		let abort_b = cancel_b.emplace_abort_token();

		let task_a = spawn_shell(&pid_file_a, cancel_a);
		let task_b = spawn_shell(&pid_file_b, cancel_b);

		let pid_a = wait_for_pid(&pid_file_a).await;
		let pid_b = wait_for_pid(&pid_file_b).await;
		assert_ne!(pid_a, pid_b, "independent runs should not reuse the same child pid");

		abort_a.abort(AbortReason::User);
		let _result_a = time::timeout(Duration::from_secs(10), task_a)
			.await
			.expect("first shell should finish after cancellation")
			.expect("first shell task should not panic")
			.expect("first shell should return a result");

		let still_running =
			Process::from_pid(pid_b).is_some_and(|process| process.status() == ProcessStatus::Running);
		assert!(still_running, "second shell child should survive first-shell cancellation");

		abort_b.abort(AbortReason::User);
		let _result_b = time::timeout(Duration::from_secs(10), task_b)
			.await
			.expect("second shell should finish after cancellation")
			.expect("second shell task should not panic")
			.expect("second shell should return a result");

		if let Some(process) = Process::from_pid(pid_a) {
			let _ = process.kill_tree(None);
		}
		if let Some(process) = Process::from_pid(pid_b) {
			let _ = process.kill_tree(None);
		}
		let _ = fs::remove_file(&pid_file_a).await;
		let _ = fs::remove_file(&pid_file_b).await;
	}
}
