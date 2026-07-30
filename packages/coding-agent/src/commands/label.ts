/**
 * Record a ground-truth outcome label on a session transcript.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runLabelCommand } from "../cli/label-cli";
import { formatSessionOutcome, SESSION_OUTCOMES } from "../health/outcome";

export default class Label extends Command {
	static description =
		"Record a ground-truth session outcome label (done | partial | manual-takeover | abandoned) for health analysis; the last label wins, so relabeling corrects earlier ones";

	static args = {
		outcome: Args.string({
			description: `Outcome label: ${SESSION_OUTCOMES.join(" | ")}`,
			required: true,
			options: SESSION_OUTCOMES,
		}),
		session: Args.string({
			description: "Session file path or session id prefix (default: most recent session for this directory)",
			required: false,
		}),
	};

	static flags = {
		note: Flags.string({ description: 'Free-form context stored with the label (e.g. "user finished by hand")' }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Label);
		try {
			const result = await runLabelCommand({ outcome: args.outcome ?? "", session: args.session, note: flags.note });
			process.stdout.write(`labeled ${result.sessionPath}\n${formatSessionOutcome(result.label)}\n`);
		} catch (error) {
			process.stderr.write(`label: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		}
	}
}
