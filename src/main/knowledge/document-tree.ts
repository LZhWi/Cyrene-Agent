import { extractHeadings } from "../learn/obsidian/obsidian-markdown";

export interface DocumentNode {
  nodeId: string;
  parentId: string | null;
  title: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
  preview: string;
  startOffset: number;
  ownEndOffset: number;
  endOffset: number;
}

/** Preview is an extract from the source, not a generated summary. IDs require the matching file hash. */
export function buildDocumentTree(content: string, markdown = true): DocumentNode[] {
  const headings = markdown ? extractHeadings(content) : [];
  const lineOffsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") lineOffsets.push(i + 1);
  }
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = lineOffsets.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (lineOffsets[mid] <= offset) low = mid + 1;
      else high = mid;
    }
    return Math.max(1, low);
  };
  const makeNode = (
    nodeId: string, parentId: string | null, title: string, headingPath: string[],
    startOffset: number, bodyOffset: number, ownEndOffset: number, endOffset: number,
  ): DocumentNode => ({
    nodeId, parentId, title, headingPath,
    startLine: lineAt(startOffset),
    endLine: lineAt(Math.max(startOffset, endOffset - 1)),
    preview: content.slice(bodyOffset, ownEndOffset).trim().slice(0, 240),
    startOffset, ownEndOffset, endOffset,
  });
  const nodes = [makeNode("document", null, "文档", [], 0, 0, headings[0]?.startOffset ?? content.length, content.length)];
  // Next equal/shallower heading determines the subtree boundary. Linear even for large outlines.
  const ends: number[] = [];
  const following: number[] = [];
  for (let i = headings.length - 1; i >= 0; i--) {
    while (following.length && headings[following[following.length - 1]].level > headings[i].level) following.pop();
    ends[i] = following.length ? headings[following[following.length - 1]].startOffset : content.length;
    following.push(i);
  }
  const parents: number[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    while (parents.length && headings[parents[parents.length - 1]].level >= h.level) parents.pop();
    const parentId = parents.length ? `h${parents[parents.length - 1] + 1}` : "document";
    nodes.push(makeNode(`h${i + 1}`, parentId, h.text, h.path, h.startOffset, h.endOffset,
      headings[i + 1]?.startOffset ?? content.length, ends[i]));
    parents.push(i);
  }
  return nodes;
}

export function nodeText(content: string, node: DocumentNode, includeChildren: boolean): string {
  return content.slice(node.startOffset, includeChildren ? node.endOffset : node.ownEndOffset);
}
