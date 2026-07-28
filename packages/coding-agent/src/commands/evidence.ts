/**
 * Compile recent sessions' health data into a layered evidence report.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runEvidenceCommand } from "../cli/evidence-cli";

export default class Evidence extends Command {
	static description =
		"Compile doctor findings, stage timings, outbound summaries, and stats health signals for recent sessions into one layered markdown evidence report";

	static flags = {
		sessions: Flags.integer({ description: "Most recent sessions to analyze", default: 10 }),
		out: Flags.string({ description: "Write the report to a file instead of stdout" }),
		json: Flags.boolean({ description: "Emit the structured per-session bundles as JSON" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Evidence);
		try {
			await runEvidenceCommand({ sessions: flags.sessions, out: flags.out, json: flags.json });
		} catch (error) {
			process.stderr.write(`evidence: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		}
	}
}
