# run-activity

## run-activity-001

- Vitest: "activityExcerpt > drops code points that PostgreSQL refuses inside jsonb"
- Mode: run
- Intent: review
- Given: The activity text contains `abcd` interspersed with NUL and unpaired high and low UTF-16 surrogates.
- When: An activity excerpt is produced.
- Then: The excerpt is exactly `abcd`.

## run-activity-002

- Vitest: "activityExcerpt > keeps a paired surrogate intact and counts it as one code point"
- Mode: run
- Intent: review
- Given: Activity text begins with an emoji represented by a surrogate pair, followed by `tail`.
- When: An activity excerpt is produced.
- Then: The emoji and suffix remain intact.

## run-activity-003

- Vitest: "activityExcerpt > bounds long input by code points rather than UTF-16 units"
- Mode: run
- Intent: review
- Given: Activity text contains 800 copies of an emoji requiring a surrogate pair.
- When: An activity excerpt is produced.
- Then: The excerpt is 700 Unicode code points long.

## run-activity-004

- Vitest: "mergeActivity > truncates a tool name without splitting a surrogate pair"
- Mode: run
- Intent: review
- Given: A tool-use event names a tool with 99 ASCII characters, an emoji, and 20 more characters.
- When: The event is projected into run activity.
- Then: The projected name contains the 99 characters and complete emoji. The JSON contains none of the rejected NUL or lone-surrogate escapes.

## run-activity-005

- Vitest: "mergeActivity > truncates a call identifier without splitting a surrogate pair"
- Mode: run
- Intent: review
- Given: A tool-use event has a call identifier with 159 ASCII characters, an emoji, and 20 more characters.
- When: The event is projected into run activity.
- Then: The projected identifier contains the 159 characters and complete emoji. The JSON contains none of the rejected NUL or lone-surrogate escapes.

## run-activity-006

- Vitest: "mergeActivity > removes jsonb-rejected code points from projected tool arguments"
- Mode: run
- Intent: review
- Given: A tool-use event has a command argument consisting of `cat`, a NUL, `binary`, and a lone high surrogate.
- When: The event is projected into run activity.
- Then: The excerpt includes `catbinary` and the serialized entries contain none of the rejected NUL or lone-surrogate escapes.

## run-activity-007

- Vitest: "mergeActivity > is idempotent for a repeated batch so a failed write can be replayed"
- Mode: run
- Intent: review
- Given: A first batch has two tool-use events with distinct call IDs and sequential event numbers.
- When: The same batch is merged again after projecting it once.
- Then: The activity entries and activity revision are unchanged.
