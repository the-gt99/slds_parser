export { normalizeSourceValue, ProductClassifier, type ProductClassifierRun } from "./product-classifier.js";
export { TargetReferenceMappingService } from "./target-reference-mapping-service.js";
export {
  ClassifierAdminService,
  type ClassificationDecisionCommand,
  type ClassificationRuleDraft,
  type ClassificationRulePreview,
  type ClassificationRulePreviewExample,
} from "./classifier-admin-service.js";
export {
  classificationRuleScore,
  compareClassificationRuleScore,
  matchesClassificationCondition,
  matchesClassificationRule,
  normalizeClassificationValue,
} from "./classification-rule-matcher.js";
export {
  TargetDictionaryService,
  type CreateTargetTermCommand,
} from "./target-dictionary-service.js";
