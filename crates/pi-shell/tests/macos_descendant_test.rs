#[cfg(target_os = "macos")]
mod tests {
	use std::{
		path::PathBuf,
		process::Command,
		time::{Duration, SystemTime, UNIX_EPOCH},
	};

	use pi_shell::process::{Process, ProcessStatus};
	use tokio::{fs, time};

	fn unique_pid_file() -> PathBuf {
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("clock should be after unix epoch")
			.as_nanos();
		std::env::temp_dir().join(format!("pi-shell-macos-grandchild-{suffix}.pid"))
	}

	async fn wait_for_pid(path: &PathBuf) -> i32 {
		let text = time::timeout(Duration::from_secs(5), async {
			loop {
				if let Ok(text) = fs::read_to_string(path).await {
					break text;
				}
				time::sleep(Duration::from_millis(25)).await;
			}
		})
		.await
		.expect("grandchild pid file should be written");
		text
			.trim()
			.parse::<i32>()
			.expect("grandchild pid file should contain an integer pid")
	}

	async fn wait_for_exit(pid: i32, label: &str) {
		time::timeout(Duration::from_secs(5), async {
			loop {
				let running = Process::from_pid(pid)
					.is_some_and(|process| process.status() == ProcessStatus::Running);
				if !running {
					break;
				}
				time::sleep(Duration::from_millis(25)).await;
			}
		})
		.await
		.unwrap_or_else(|_| panic!("{label} should exit within grace window"));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn kill_tree_reaps_grandchild_from_a_single_snapshot() {
		let pid_file = unique_pid_file();
		let _ = fs::remove_file(&pid_file).await;
		let script = "sh -c 'sleep 1000 & echo $! > \"$GC_PID\"; sleep 0.2' & sleep 1000";
		let mut child = Command::new("sh")
			.arg("-c")
			.arg(script)
			.env("GC_PID", pid_file.display().to_string())
			.spawn()
			.expect("root shell should spawn");
		let root_pid = i32::try_from(child.id()).expect("root pid should fit in i32");
		let grandchild_pid = wait_for_pid(&pid_file).await;
		let root = Process::from_pid(root_pid).expect("root process should still be running");
		let grandchild_running = Process::from_pid(grandchild_pid)
			.is_some_and(|process| process.status() == ProcessStatus::Running);
		assert!(grandchild_running, "grandchild should still be running before kill_tree");

		let _ = root.kill_tree(None);
		wait_for_exit(grandchild_pid, "grandchild").await;
		wait_for_exit(root_pid, "root process").await;
		let _ = child.wait();
		let _ = fs::remove_file(&pid_file).await;
	}
}
