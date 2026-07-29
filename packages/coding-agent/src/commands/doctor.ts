/**
 * Analyze a session transcript for degradation signals.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type DoctorCommandArgs, runDoctorCommand } from "../cli/doctor-cli";

export default class Doctor extends Command {
	static description =
		"Analyze a session for health findings (model switches, orphaned tool pairs, error turns, oversized messages)";

	static args = {
		session: Args.string({
			description: "Session file path or session id prefix (default: most recent session for this directory)",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		outbound: Flags.boolean({
			description:
				"Show recent outbound provider-request summaries (what the model actually saw) with per-request diffs",
		}),
		stages: Flags.boolean({
			description:
				"Show per-turn pipeline stage timings (context transform, provider ttfb/stream, tool execution) with the slowest turns",
		}),
		autopsy: Flags.boolean({
			description:
				"Show the deterministic behavioral autopsy (error clusters, repeated command prefixes, ending state, ask waits) — computed evidence, human judgment",
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Doctor);
		const cmd: DoctorCommandArgs = {
			session: args.session,
			flags: { json: flags.json, outbound: flags.outbound, stages: flags.stages, autopsy: flags.autopsy },
		};
		try {
			await runDoctorCommand(cmd);
		} catch (error) {
			process.stderr.write(`doctor: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		}
	}
}
