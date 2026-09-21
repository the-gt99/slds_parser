import type { ReferenceCandidateDTO, UniversalProductDTO } from "../contracts/index.js";
import { stableJsonStringify } from "../core/utils/index.js";
import type { RuleV2Record } from "../repositories/index.js";
import { directCandidateConditions, directCandidateField } from "./rules-v2-direct-candidate.js";
import { DirectRulesV2Index, matchesDirectRulesV2Conditions } from "./rules-v2-direct-fields.js";
import type { RulesV2ProductSource } from "./rules-v2-snapshot.js";

interface PreparedRule {
  readonly rule: RuleV2Record;
  readonly groups: RuleV2Record["conditionGroups"];
}

export interface DirectSourceSelection {
  readonly candidateKey: string;
  readonly status: "resolved" | "ignored" | "unresolved" | "ambiguous";
  readonly sourceRuleId: string | null;
}

const key = (...parts: readonly unknown[]) => JSON.stringify(parts);
const normalized = (value: string) => value.trim().normalize("NFKC").toLowerCase();

/** Selects the winning imported source rule without querying legacy mapping or reference tables. */
export class DirectRulesV2Selector {
  private readonly exact = new Map<string, RuleV2Record>();
  private readonly conditional = new Map<string, DirectRulesV2Index<PreparedRule>>();

  constructor(records: readonly RuleV2Record[]) {
    const conditional = new Map<string, PreparedRule[]>();
    for (const rule of records) {
      if (rule.status !== "shadow" || rule.sourceId === null) continue;
      const action = rule.actions.find((item) => item.kind === "resolve_reference");
      if (action?.kind !== "resolve_reference") continue;
      if (rule.originKind === "exact_mapping") {
        const lookup = key(rule.sourceId, action.referenceType, rule.originPayload.scope,
          rule.originPayload.normalizedSourceValue, rule.originPayload.contextKey);
        if (this.exact.has(lookup)) throw new Error(`Duplicate direct exact decision: ${rule.id}`);
        this.exact.set(lookup, rule);
      } else if (rule.originKind === "classification_rule") {
        const groups = directCandidateConditions(rule);
        const lookup = key(rule.sourceId, action.referenceType);
        const entries = conditional.get(lookup) ?? [];
        entries.push({ rule, groups });
        conditional.set(lookup, entries);
      }
    }
    for (const [lookup, entries] of conditional) this.conditional.set(lookup, new DirectRulesV2Index(entries));
  }

  select(source: RulesV2ProductSource, product: UniversalProductDTO): readonly DirectSourceSelection[] {
    return product.referenceCandidates.map((candidate): DirectSourceSelection => {
      const exact = this.exact.get(key(source.id, candidate.typeCode, candidate.scope,
        normalized(candidate.sourceValue), stableJsonStringify(candidate.context)));
      if (exact !== undefined) {
        const action = exact.actions.find((item) => item.kind === "resolve_reference");
        return { candidateKey: candidate.key, status: action?.kind === "resolve_reference" && action.resolutionStatus === "ignored"
          ? "ignored" : "resolved", sourceRuleId: exact.id };
      }
      const candidateRead = (field: string): readonly string[] => directCandidateField(candidate, field);
      const matches = (this.conditional.get(key(source.id, candidate.typeCode))?.select(candidateRead) ?? [])
        .filter((entry) => matchesDirectRulesV2Conditions(product, entry.groups, candidateRead))
        .sort((left, right) => right.rule.priority - left.rule.priority
          || right.rule.conditionGroups.length - left.rule.conditionGroups.length
          || String(left.rule.originId ?? left.rule.id).localeCompare(String(right.rule.originId ?? right.rule.id)));
      const first = matches[0];
      if (first === undefined) return { candidateKey: candidate.key, status: "unresolved", sourceRuleId: null };
      const best = matches.filter((entry) => entry.rule.priority === first.rule.priority
        && entry.rule.conditionGroups.length === first.rule.conditionGroups.length);
      const references = new Set(best.flatMap((entry) => entry.rule.actions.flatMap((item) =>
        item.kind === "resolve_reference" ? [item.referenceValueId] : [])));
      if (references.size > 1) return { candidateKey: candidate.key, status: "ambiguous", sourceRuleId: null };
      return { candidateKey: candidate.key, status: "resolved", sourceRuleId: first.rule.id };
    });
  }
}
