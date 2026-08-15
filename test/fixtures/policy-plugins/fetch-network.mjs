export default async function project() {
  await fetch("http://127.0.0.1:9/");
  return { selectedNodes: [], appendContent: null };
}
