export interface RuleSuggestionItem {
  readonly typeCode: string;
  readonly sourceValue: string;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly examples?: readonly {
    readonly evidence?: Readonly<Record<string, unknown>>;
  }[];
}

export interface SuggestedRuleCondition {
  readonly field: string;
  readonly operator: string;
  readonly value: string;
}

export function suggestRuleConditions(item: RuleSuggestionItem): SuggestedRuleCondition[];
