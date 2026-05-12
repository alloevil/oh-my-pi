use std::{
	fs,
	io::Read,
	sync::{Arc, Mutex},
};

use anyhow::{Error, Result};
use brush_core::openfiles::OpenFile;

#[cfg(unix)]
pub type PtyMasterHandle = Arc<Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>>;
#[cfg(not(unix))]
pub type PtyMasterHandle = ();

#[cfg(unix)]
pub struct PtyIo {
	pub(crate) reader: Box<dyn Read + Send>,
	pub(crate) stdin:  OpenFile,
	pub(crate) stdout: OpenFile,
	pub(crate) stderr: OpenFile,
	pub(crate) master: PtyMasterHandle,
}

#[cfg(unix)]
pub fn open() -> Result<PtyIo> {
	use portable_pty::{PtySize, native_pty_system};

	let pair = native_pty_system()
		.openpty(PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 })
		.map_err(|err| Error::msg(format!("Failed to open PTY: {err}")))?;
	let reader = pair
		.master
		.try_clone_reader()
		.map_err(|err| Error::msg(format!("Failed to clone PTY reader: {err}")))?;
	let tty_name = pair
		.master
		.tty_name()
		.ok_or_else(|| Error::msg("PTY master did not expose a slave device path"))?;
	let slave = fs::OpenOptions::new()
		.read(true)
		.write(true)
		.open(&tty_name)
		.map_err(|err| {
			Error::msg(format!("Failed to open PTY slave {}: {err}", tty_name.display()))
		})?;
	let stdin = OpenFile::from(
		slave
			.try_clone()
			.map_err(|err| Error::msg(format!("Failed to clone PTY stdin: {err}")))?,
	);
	let stdout = OpenFile::from(
		slave
			.try_clone()
			.map_err(|err| Error::msg(format!("Failed to clone PTY stdout: {err}")))?,
	);
	let stderr = OpenFile::from(slave);
	Ok(PtyIo { reader, stdin, stdout, stderr, master: Arc::new(Mutex::new(Some(pair.master))) })
}

#[cfg(unix)]
pub fn close_master(master: &PtyMasterHandle) {
	if let Ok(mut guard) = master.lock() {
		guard.take();
	}
}
#[cfg(not(unix))]
pub fn close_master(_master: &PtyMasterHandle) {}
