#[cfg(unix)]
mod tests {
	use std::{
		path::PathBuf,
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use pi_shell::{
		ShellExecuteOptions,
		cancel::CancelToken,
		execute_shell,
		process::{Process, ProcessStatus},
	};
	use tokio::{fs, time};

	fn unique_pid_file() -> PathBuf {
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("clock should be after unix epoch")
			.as_nanos();
		std::env::temp_dir().join(format!("pi-shell-background-{suffix}.pid"))
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn timeout_terminates_background_descendants() {
		let pid_file = unique_pid_file();
		let _ = fs::remove_file(&pid_file).await;
		let result = execute_shell(
			ShellExecuteOptions {
				command: "sh -c 'sleep 1000 & echo $! > \"$PID_FILE\"; echo started; wait'".to_string(),
				env: Some(std::collections::HashMap::from([(
					"PID_FILE".to_string(),
					pid_file.display().to_string(),
				)])),
				..Default::default()
			},
			None,
			CancelToken::new(Some(200)),
		)
		.await
		.expect("shell execution should complete");
		assert!(result.timed_out, "expected timeout result");

		let pid_text = time::timeout(Duration::from_secs(5), async {
			loop {
				if let Ok(text) = fs::read_to_string(&pid_file).await {
					break text;
				}
				time::sleep(Duration::from_millis(50)).await;
			}
		})
		.await
		.expect("pid file should be written before timeout cleanup finishes");
		let pid = pid_text
			.trim()
			.parse::<i32>()
			.expect("pid file should contain an integer pid");

		let terminated = time::timeout(Duration::from_secs(5), async {
			loop {
				let is_running = Process::from_pid(pid)
					.is_some_and(|process| process.status() == ProcessStatus::Running);
				if !is_running {
					break true;
				}
				time::sleep(Duration::from_millis(50)).await;
			}
		})
		.await
		.expect("background child should terminate within grace window");
		assert!(terminated, "background child should be terminated");
		let _ = fs::remove_file(&pid_file).await;
	}
}
