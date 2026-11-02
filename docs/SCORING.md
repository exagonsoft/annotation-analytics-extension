# Verified scoring and analytics

## Mapping

No task-answer score path or category is enabled by default. Inspect a real record and configure each dimension in Settings. Dot paths and numeric array indexes are supported, for example `annotationData.results.0.value` or `relatedResult.overall` **only if those paths actually exist in your data**.

The inspector and autocomplete operate on parsed, redacted JSON. A preview counts verified/invalid/missing values in up to 100 loaded records; Apply recalculates the entire current dataset.

## Numeric rules

Numeric mapping requires:

- A finite JSON number (no numeric-string coercion).
- Explicit finite minimum and maximum, with minimum less than maximum.
- A nonempty verified scale name.
- A value inside the inclusive bounds.

For mixed-rubric datasets, expand **Per-record scale metadata** and configure verified scale-name/minimum/maximum JSON paths. Each configured path overrides its corresponding static value. Missing or invalid per-record metadata invalidates the score rather than silently falling back to another rubric. This supports multiple real scales in the same collection without conversion.

The compatibility key includes scale name, bounds and record level. Each group has its own arithmetic mean:

```text
mean = sum(valid compatible scores) / count(valid compatible scores)
```

Missing, invalid, categorical and unmapped records are excluded from both numerator and denominator. An empty group has no mean, not zero. Multiple incompatible groups display "Multiple scales" and separate averages. No implicit scale normalization or conversion exists.

Task-level mapping additionally requires a verified task identity path. Repeated task results are counted once per origin/project/task identity in a dimension's aggregate; annotation-level scores remain per annotation. Do not select task-level mapping unless the platform's result actually represents a task-level evaluation. When one task's attempts expose conflicting task-level results, that task group is excluded from aggregates and the dashboard warns you. Inspect and resolve that source inconsistency instead of interpreting conflicting attempts as independent votes.

## Categorical rules

Observed mapped strings become categories. Optional allowed-category configuration rejects values outside the configured list. No A/B category names are installed by default, and categories are never assigned numeric weights.

Category percentages use the count of verified categorical results as their denominator, not all annotations. Numeric and categorical distributions remain identifiable. Task-level repeated results are deduplicated as above.

## Global scope

Global filters feed every dashboard metric and chart. Date filters use inclusive UTC day boundaries on `createdAt`. Undated records are excluded when a date filter is active. Numeric score filters should include a scale selection when multiple scales are loaded.

Submitted means `record.state === SUBMITTED`. Pending counts only recognized pending states. Other/unknown states are not guessed to be pending. Completion is submitted divided by matching loaded annotations; it is not a claim about all tasks on the server.

Volume and submission trends group the currently loaded records by creation date. They do not reconstruct historical state transitions or submission timestamps that the payload did not provide.

Charts cap visible bars at the top 20 groups; their "View all values" section lists the complete distribution. Numeric trends offer a scale-specific selector and preserve gaps without scoring data.

## Reviewer quality is separate

LinkedIn review quality is extracted automatically from the confirmed `currentVersionReview.annotationScore`, with review status and feedback from that same object. It is not the annotation's submitted Overall/Aesthetics/Functionality answer. Mappings into `currentVersionReview` are invalid as task-answer mappings; the database migration also removes previously misclassified task-answer values from these fields.

Review Analytics averages only finite numeric annotation scores, excluding null, missing, nonnumeric and nonfinite values. Zero remains zero; the true range is unverified, so no 1-5 restriction or conversion is imposed. Review presence does not imply a numeric score. Unknown valid statuses remain strings; approval uses exact `APPROVED` divided by reviewed records with a non-null status, and the UI shows that denominator.

Review filters drive all review metrics independently of task-answer filters. Creation or submitted/ended dates are explicit filter bases. Trends are not historical review timestamps; recent reviews means last observed. Unfetched records are unknown, not unreviewed, and failed refreshes can retain cached scores. See [review collection](REVIEW_COLLECTION.md).
