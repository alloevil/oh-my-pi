//! Bash execution.

use std::{
	collections::HashMap,
	convert::Infallible,
	path::{Path, PathBuf},
	pin::Pin,
	sync::{Arc, LazyLock},
	task::{Context, Poll},
	time::Duration,
};

use axum::{
	Json,
	body::Body,
	extract::{Path as AxumPath, State},
	http::{HeaderValue, StatusCode, header},
	response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use bytes::Bytes;
use futures_util::Stream;
use pi_shell::{
	Shell as BrushShell, ShellChunk, ShellOptions as BrushShellOptions, ShellRunOptions,
	cancel::{AbortReason, AbortToken, CancelToken},
	minimizer::MinimizerOptions as ShellMinimizerOptions,
};
use serde::Deserialize;
use tokio::sync::{Mutex, mpsc};
use tokio_stream::wrappers::ReceiverStream;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
	fs_ops::{HEARTBEAT_INTERVAL, heartbeat_stream},
	protocol::{
		error::{ApiError, ApiResult, ErrorBody},
		events::{BashEvent, BashExitMinimizer},
		requests::{BashExecMinimizer, BashExecRequest},
	},
	state::AppState,
};

type SessionShellMap = HashMap<(Uuid, String), Arc<BrushShell>>;

static SHELL_SESSIONS: LazyLock<Mutex<SessionShellMap>> =
	LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "lowercase")]
enum BashOutputStreams {
	#[default]
	Merged,
	Split,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct BashExecBody {
	#[serde(flatten)]
	request:        BashExecRequest,
	#[serde(default)]
	output_streams: BashOutputStreams,
}

// Silent disconnect without subsequent writes is not observed reliably by
// hyper/axum chunked responses. Emit heartbeats so stale-write detection trips
// promptly when the client disappears.
struct CancelOnDropStream<S> {
	inner: Pin<Box<S>>,
	abort: AbortToken,
}

impl<S> Stream for CancelOnDropStream<S>
where
	S: Stream<Item = Result<Bytes, Infallible>>,
{
	type Item = Result<Bytes, Infallible>;

	fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
		self.inner.as_mut().poll_next(cx)
	}
}

impl<S> Drop for CancelOnDropStream<S> {
	fn drop(&mut self) {
		self.abort.abort(AbortReason::Signal);
	}
}

#[utoipa::path(
	post,
	path = "/sessions/{id}/bash.exec",
	params(("id" = Uuid, Path)),
	request_body = BashExecBody,
	responses(
		(status = 200, content_type = "application/x-ndjson"),
		(status = 404, body = ErrorBody, description = "session not found"),
		(status = 499, body = ErrorBody, description = "client closed request"),
		(status = 500, body = ErrorBody, description = "internal server error"),
	),
)]
pub async fn bash_exec(
	State(state): State<AppState>,
	AxumPath(id): AxumPath<Uuid>,
	Json(body): Json<BashExecBody>,
) -> ApiResult<impl IntoResponse> {
	let BashExecBody { request: body, output_streams } = body;
	let session = state
		.sessions
		.get(id)
		.ok_or_else(|| ApiError::NotFound(format!("session {id} not found")))?;
	let shell = shell_for_request(id, &session, body.session_key.as_deref()).await;
	let cwd = resolve_cwd(&session.cwd(), body.cwd.as_deref());
	let env = if body.env.is_empty() {
		None
	} else {
		Some(body.env.into_iter().collect::<HashMap<_, _>>())
	};
	let timeout = body.timeout_ms.map(Duration::from_millis);
	let run_options = ShellRunOptions {
		command: body.command,
		cwd: Some(cwd.to_string_lossy().into_owned()),
		env,
		pty: body.pty,
		timeout_ms: body.timeout_ms.and_then(|value| u32::try_from(value).ok()),
		minimizer: body.minimizer.as_ref().map(to_shell_minimizer),
	};

	let session_cancel = session.cancellation_token.child_token();
	let cancel_race_token = session_cancel.clone();
	let response_cancel = session.cancellation_token.child_token();
	let mut cancel_token = CancelToken::with_timeout(timeout);
	let abort = cancel_token.emplace_abort_token();
	let abort_for_task = abort.clone();
	let (chunk_tx, mut chunk_rx) = mpsc::unbounded_channel::<ShellChunk>();
	let (body_tx, body_rx) = mpsc::channel::<Bytes>(32);

	tokio::spawn(async move {
		let shell_task = tokio::spawn({
			let shell = shell.clone();
			async move { shell.run(run_options, Some(chunk_tx), cancel_token).await }
		});
		let mut stream_open = true;

		loop {
			tokio::select! {
				() = session_cancel.cancelled() => {
					stream_open = false;
					abort_for_task.abort(AbortReason::Signal);
					break;
				}
				chunk = chunk_rx.recv() => {
					let Some(chunk) = chunk else {
						break;
					};
					let event = output_event(output_streams, chunk);
					if stream_open && body_tx.send(encode_event(&event)).await.is_err() {
						stream_open = false;
						abort_for_task.abort(AbortReason::Signal);
						break;
					}
				}
			}
		}

		if let Ok(Ok(result)) = shell_task.await
			&& stream_open
			&& !session_cancel.is_cancelled()
		{
			let _ = body_tx
				.send(encode_event(&BashEvent::Exit {
					code:      result.exit_code,
					cancelled: result.cancelled,
					timed_out: result.timed_out,
					minimizer: result.minimized.as_ref().map(to_exit_minimizer),
				}))
				.await;
		}
	});
	// Race session cancellation against the start of the response.
	// If cancellation fires within ~150ms before any body is written, return 499.
	tokio::select! {
		() = cancel_race_token.cancelled() => return Ok(cancelled_response()),
		() = tokio::time::sleep(Duration::from_millis(150)) => {}
	}

	let stream = heartbeat_stream(
		ReceiverStream::new(body_rx),
		HEARTBEAT_INTERVAL,
		response_cancel,
		encode_event(&BashEvent::Heartbeat),
	);
	let mut response =
		Response::new(Body::from_stream(CancelOnDropStream { inner: Box::pin(stream), abort }));
	*response.status_mut() = StatusCode::OK;
	response
		.headers_mut()
		.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/x-ndjson"));
	Ok(response)
}

fn output_event(output_streams: BashOutputStreams, chunk: ShellChunk) -> BashEvent {
	match (output_streams, chunk) {
		(BashOutputStreams::Merged, ShellChunk::Stdout(data) | ShellChunk::Stderr(data)) => {
			BashEvent::Output { data }
		},
		(BashOutputStreams::Split, ShellChunk::Stdout(data)) => BashEvent::Stdout { data },
		(BashOutputStreams::Split, ShellChunk::Stderr(data)) => BashEvent::Stderr { data },
	}
}
fn cancelled_response() -> Response {
	let mut response = Response::new(Body::empty());
	*response.status_mut() = StatusCode::from_u16(499).unwrap_or(StatusCode::SERVICE_UNAVAILABLE);
	response
}

fn encode_event(event: &BashEvent) -> Bytes {
	let mut encoded = serde_json::to_vec(event).expect("bash event should serialize");
	encoded.push(b'\n');
	Bytes::from(encoded)
}

async fn shell_for_request(
	session_id: Uuid,
	session: &Arc<crate::session::Session>,
	session_key: Option<&str>,
) -> Arc<BrushShell> {
	let key = (session_id, session_key.unwrap_or("default").to_owned());
	{
		let guard = SHELL_SESSIONS.lock().await;
		if let Some(shell) = guard.get(&key) {
			return Arc::clone(shell);
		}
	}
	let session_env = Some(
		session
			.env_snapshot()
			.into_iter()
			.collect::<HashMap<_, _>>(),
	);
	let shell = Arc::new(BrushShell::new(Some(BrushShellOptions {
		session_env,
		snapshot_path: None,
		minimizer: None,
	})));
	let mut guard = SHELL_SESSIONS.lock().await;
	Arc::clone(guard.entry(key).or_insert_with(|| Arc::clone(&shell)))
}

fn to_shell_minimizer(minimizer: &BashExecMinimizer) -> ShellMinimizerOptions {
	let _ = minimizer.aggressive;
	let _ = minimizer.min_lines;
	let _ = minimizer.context_lines;
	ShellMinimizerOptions { enabled: Some(minimizer.enabled), ..Default::default() }
}

fn to_exit_minimizer(minimized: &pi_shell::MinimizerResult) -> BashExitMinimizer {
	let original_text = minimized.original_text.as_str();
	let original_lines = original_text.lines().count();
	let minimized_lines = minimized.text.lines().count();
	BashExitMinimizer {
		minimized: true,
		original_lines,
		minimized_lines,
		omitted_lines: original_lines.saturating_sub(minimized_lines),
		truncated: minimized.output_bytes < minimized.input_bytes,
		raw_artifact: Some(crate::protocol::events::BashRawArtifact::Bytes {
			bytes: BASE64_STANDARD.encode(original_text.as_bytes()),
		}),
	}
}

fn resolve_cwd(base: &Path, requested: Option<&str>) -> PathBuf {
	match requested {
		Some(path) => {
			let requested = PathBuf::from(path);
			if requested.is_absolute() {
				requested
			} else {
				base.join(requested)
			}
		},
		None => base.to_path_buf(),
	}
}
