#[cfg(unix)]
mod tests {
	use std::time::Duration;

	use pi_shell::{ShellExecuteOptions, cancel::CancelToken, execute_shell};
	use tokio::{sync::mpsc, time};

	fn python_command() -> &'static str {
		for candidate in ["python3", "python"] {
			if std::process::Command::new(candidate)
				.arg("-c")
				.arg("print('ok')")
				.status()
				.is_ok_and(|status| status.success())
			{
				return candidate;
			}
		}
		panic!("python3 or python must be available for PTY test");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn pty_mode_streams_output() {
		let python = python_command();
		let (tx, mut rx) = mpsc::unbounded_channel();
		let command =
			format!("{python} -c 'import sys; sys.stdout.write(\"a\\n\"); sys.stdout.flush()'");
		let result = execute_shell(
			ShellExecuteOptions { command, pty: true, ..Default::default() },
			Some(tx),
			CancelToken::new(None),
		)
		.await
		.expect("shell execution should succeed");
		assert_eq!(result.exit_code, Some(0));

		let output = time::timeout(Duration::from_secs(2), async {
			let mut output = String::new();
			while let Some(chunk) = rx.recv().await {
				match chunk {
					pi_shell::ShellChunk::Stdout(text) | pi_shell::ShellChunk::Stderr(text) => {
						output.push_str(&text);
					},
				}
			}
			output
		})
		.await
		.expect("output channel should close after command exits");
		assert!(output.contains('a'), "expected PTY output, got {output:?}");
	}
}
