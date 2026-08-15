export default function adopt(input) {
  if (input.evaluation.status !== "completed") {
    return { kind: "reject", reason: { code: "PLUGIN_NOT_COMPLETED" } };
  }
  if (input.emissions.length !== 1) {
    return { kind: "reject", reason: { code: "PLUGIN_EMISSION_COUNT" } };
  }
  return {
    kind: "adopt",
    block: {
      version: "evaluation-frame/v2",
      input: input.candidateInput,
      output: input.emissions[0].payload,
    },
  };
}
