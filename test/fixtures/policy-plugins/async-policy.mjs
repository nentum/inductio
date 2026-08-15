export default async function project(input) {
  return {
    selectedNodes: [],
    appendContent: {
      version: "offline-model-input/v1",
      history: [],
      candidateInput: input.candidateInput,
      environment: input.environment,
    },
  };
}
