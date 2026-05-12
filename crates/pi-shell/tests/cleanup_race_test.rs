#[cfg(unix)]
mod tests {
	use std::{
		collections::HashMap,
		path::PathBuf,
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use pi_shell::{
		ShellExecuteOptions,
		cancel::{AbortReason, CancelToken},
		execute_shell,
		shell::active_tracker_task_count_for_test,
	};
	use tokio::{fs, time};

	fn unique_pid_file() -> PathBuf {
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("clock should be after unix epoch")
			.as_nanos();
		std::env::temp_dir().join(format!("pi-shell-cleanup-race-{suffix}.pid"))
	}

	async fn wait_for_pid_file(path: &PathBuf) {
		time::timeout(Duration::from_secs(5), async {
			loop {
				if fs::try_exists(path)
					.await
					.expect("pid file stat should succeed")
				{
					break;
				}
				time::sleep(Duration::from_millis(50)).await;
			}
		})
		.await
		.expect("pid file should be written before cancellation");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn outer_abort_path_does_not_leave_tracker_tasks_running() {
		assert_eq!(active_tracker_task_count_for_test(), 0, "test should start clean");
		let pid_file = unique_pid_file();
		let _ = fs::remove_file(&pid_file).await;

		let mut cancel_token = CancelToken::default();
		let abort_token = cancel_token.emplace_abort_token();
		let shell_task = tokio::spawn(execute_shell(
			ShellExecuteOptions {
				command: "sh -c 'sleep 1000 & echo $! > \"$PID_FILE\"; wait'".to_string(),
				env: Some(HashMap::from([("PID_FILE".to_string(), pid_file.display().to_string())])),
				..Default::default()
			},
			None,
			cancel_token,
		));

		wait_for_pid_file(&pid_file).await;
		abort_token.abort(AbortReason::User);

		let _result = time::timeout(Duration::from_secs(10), shell_task)
			.await
			.expect("shell should return after forced cancellation")
			.expect("shell task should not panic")
			.expect("shell should return a result");

		time::timeout(Duration::from_secs(5), async {
			loop {
				if active_tracker_task_count_for_test() == 0 {
					break;
				}
				time::sleep(Duration::from_millis(50)).await;
			}
		})
		.await
		.expect("tracker task should be joined after outer abort cleanup");
		let _ = fs::remove_file(&pid_file).await;
	}
}
