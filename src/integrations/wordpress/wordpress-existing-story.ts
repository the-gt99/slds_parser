import { DomUtils, parseDocument } from "htmlparser2";

import { IntegrationContractError } from "../../core/errors/index.js";
import { sanitizeWordPressContentHtml } from "./wordpress-content-template.js";

type HtmlNode = ReturnType<typeof parseDocument>["children"][number];

function isText(node: HtmlNode): boolean {
  return node.type === "text";
}

function isTag(node: HtmlNode, name?: string): boolean {
  return node.type === "tag" && (name === undefined || node.name.toLowerCase() === name);
}

export function extractExistingWordPressStory(descriptionHtml: string): string {
  if (descriptionHtml.trim() === "") return "";
  const document = parseDocument(descriptionHtml, { decodeEntities: false });
  const nodes = document.children.filter((node) => !(isText(node) && DomUtils.textContent(node).trim() === ""));
  const heading = nodes[0];
  if (heading === undefined || !isTag(heading, "h2")) {
    throw new IntegrationContractError("Existing description does not start with the expected heading");
  }
  const listIndex = nodes.findIndex((node, index) => index > 0 && isTag(node, "ul"));
  if (listIndex < 0) {
    throw new IntegrationContractError("Existing description does not contain the expected characteristics list");
  }
  const list = nodes[listIndex]!;
  const hasSku = DomUtils.findAll((node) => isTag(node as HtmlNode, "li"), [list])
    .some((node) => /^\s*Артикул\s*:/iu.test(DomUtils.textContent(node).trim()));
  if (!hasSku) {
    throw new IntegrationContractError("Existing characteristics list has no SKU boundary");
  }
  const storyNodes = nodes.slice(1, listIndex);
  if (storyNodes.some((node) => !isText(node) && !isTag(node, "p"))) {
    throw new IntegrationContractError("Existing story contains an unsupported top-level element");
  }
  return sanitizeWordPressContentHtml(storyNodes.map((node) => DomUtils.getOuterHTML(node)).join("")).trim();
}
