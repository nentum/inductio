export default function project(input) {
  const nodes = input.path.filter((entry) => entry.kind === "node");
  return {
    selectedNodes: nodes.map((entry) => entry.ref),
    appendContent: {
      version: "offline-model-input/v1",
      history: nodes.map((entry) => entry.block),
      candidateInput: input.candidateInput,
      environment: input.environment,
    },
  };
}
