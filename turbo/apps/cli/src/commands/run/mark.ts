import { Command, Option } from "commander";
import { runGenerationKindSchema } from "@okouai/api-contracts/contracts/run-phase-timing";
import { markRunPhase } from "../../lib/api/domains/run-phase-timing";

export function createRunMarkCommand(): Command {
  return new Command("mark")
    .description("Record a best-effort phase boundary for the current Run")
    .addHelpText(
      "after",
      "\nValid marks are quiet by default and never fail the task on an API or transport error. HTTP deadline: 500 ms, no retries. A timeout may have committed. Run completion supplies the final boundary automatically.",
    )
    .addCommand(
      new Command("research-start")
        .description("Mark the first research action before generation")
        .option("--json", "Print the versioned outcome")
        .action(async (options: { readonly json?: boolean }) => {
          const result = await markRunPhase({ phase: "research-start" });
          if (options.json) console.log(JSON.stringify(result));
        }),
    )
    .addCommand(
      new Command("generation-start")
        .description("Mark the first artifact creation action")
        .addOption(
          new Option(
            "--kind <kind>",
            "Intended deliverable type; other must be chosen explicitly",
          )
            .choices(runGenerationKindSchema.options)
            .makeOptionMandatory(),
        )
        .option(
          "--skip-research",
          "Explicitly declare that no research was needed",
        )
        .option("--json", "Print the versioned outcome")
        .action(
          async (options: {
            readonly kind: string;
            readonly skipResearch?: boolean;
            readonly json?: boolean;
          }) => {
            const result = await markRunPhase({
              phase: "generation-start",
              kind: runGenerationKindSchema.parse(options.kind),
              skipResearch: options.skipResearch ?? false,
            });
            if (options.json) console.log(JSON.stringify(result));
          },
        ),
    );
}
