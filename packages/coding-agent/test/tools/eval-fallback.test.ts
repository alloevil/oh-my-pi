import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LocalBackend } from "../../src/backend";
import * as jsExecutor from "../../src/eval/js/executor";
import * as pyExecutor from "../../src/eval/py/executor";
import * as pyKernel from "../../src/eval/py/kernel";
import type { ToolSession } from "../../src/tools";
import { EvalTool } from "../../src/tools/eval";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		backend: new LocalBackend({ cwd: "/tmp/eval-test" }),
		settings: Settings.isolated(),
	};
}

const mockResult = {
	output: "ok",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	artifactId: undefined,
	totalLines: 1,
	totalBytes: 2,
	outputLines: 1,
	outputBytes: 2,
	displayOutputs: [],
	stdinRequested: false,
};

describe("EvalTool language resolution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("dispatches to js when fenced code declares ```js", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const jsExecuteSpy = vi.spyOn(jsExecutor, "executeJs").mockResolvedValue(mockResult);
		const pythonExecuteSpy = vi.spyOn(pyExecutor, "executePython");

		const tool = new EvalTool(makeSession());
		await tool.execute("call-1", {
			input: "```js\nconst x = 1;\n```\n",
		});

		expect(jsExecuteSpy).toHaveBeenCalledTimes(1);
		expect(pythonExecuteSpy).not.toHaveBeenCalled();
	});

	it("dispatches to python when fenced code declares ```python", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const pythonExecuteSpy = vi.spyOn(pyExecutor, "executePython").mockResolvedValue(mockResult);
		const jsExecuteSpy = vi.spyOn(jsExecutor, "executeJs");

		const tool = new EvalTool(makeSession());
		await tool.execute("call-2", {
			input: "```python\nprint('hi')\n```\n",
		});

		expect(pythonExecuteSpy).toHaveBeenCalledTimes(1);
		expect(jsExecuteSpy).not.toHaveBeenCalled();
	});

	it("auto-detects python via syntactic markers when fence is bare", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const pythonExecuteSpy = vi.spyOn(pyExecutor, "executePython").mockResolvedValue(mockResult);
		const jsExecuteSpy = vi.spyOn(jsExecutor, "executeJs");

		const tool = new EvalTool(makeSession());
		await tool.execute("call-3", {
			input: "def greet():\n    print('hi')\ngreet()\n",
		});

		expect(pythonExecuteSpy).toHaveBeenCalledTimes(1);
		expect(jsExecuteSpy).not.toHaveBeenCalled();
	});
});
