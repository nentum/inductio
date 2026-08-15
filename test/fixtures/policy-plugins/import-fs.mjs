import fs from "node:fs";

export default function project(input) {
  return fs.existsSync(input.root.root)
    ? { selectedNodes: [], appendContent: null }
    : { selectedNodes: [], appendContent: null };
}
