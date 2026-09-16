let observations = ['vm0-web-logs-prod']
| where _time >= startofday(now()) - 2d and _time < now()
| where source == 'api' and level == 'info'
| where ['fields.context'] == 'PiMemoryStage1Cost' and ['fields.operation'] == 'pi_memory_stage1'
| where tostring(['fields.billingMode']) != 'byok'
| extend accountingId = tostring(['fields.accountingId']), accountingAt = todatetime(['fields.accountingAt']), observedAt = todatetime(['fields.observedAt']), amount = todouble(['fields.grossCreditValueUsd'])
| extend incidentDay = format_datetime(_time, 'yyyy-MM-dd');
let invalid = observations
| where tostring(['fields.billingMode']) != 'builtin' or isnull(['fields.costVersion']) or ['fields.costVersion'] != 1 or tostring(['fields.usageStatus']) != 'valid'
  or tostring(['fields.ledgerStatus']) !in ('new', 'replay', 'legacy_replay', 'zero_usage', 'persistence_error', 'not_recorded')
  or isnull(tolong(['fields.inputTokens'])) or isnull(tolong(['fields.outputTokens'])) or isnull(tolong(['fields.cacheReadTokens'])) or isnull(tolong(['fields.cacheCreationTokens']))
  or todouble(['fields.inputTokens']) < 0 or todouble(['fields.outputTokens']) < 0 or todouble(['fields.cacheReadTokens']) < 0 or todouble(['fields.cacheCreationTokens']) < 0
  or todouble(['fields.inputTokens']) != tolong(['fields.inputTokens']) or todouble(['fields.outputTokens']) != tolong(['fields.outputTokens'])
  or todouble(['fields.cacheReadTokens']) != tolong(['fields.cacheReadTokens']) or todouble(['fields.cacheCreationTokens']) != tolong(['fields.cacheCreationTokens'])
  or (['fields.ledgerStatus'] == 'zero_usage' and (todouble(['fields.inputTokens']) + todouble(['fields.outputTokens']) + todouble(['fields.cacheReadTokens']) + todouble(['fields.cacheCreationTokens']) != 0))
  or (['fields.ledgerStatus'] in ('replay', 'zero_usage') and (tostring(['fields.pricingStatus']) != tostring(['fields.ledgerStatus']) or isnotnull(['fields.grossCreditValueUsd']) or isnotnull(['fields.grossCreditValueNanoUsd'])))
  or ['fields.ledgerStatus'] in ('persistence_error', 'legacy_replay', 'not_recorded')
  or (['fields.ledgerStatus'] !in ('byok', 'zero_usage') and (isempty(accountingId) or isnull(accountingAt) or isnull(observedAt)))
  or tostring(['fields.currency']) != 'USD' or tostring(['fields.unit']) != 'gross_credit_value' or isnull(['fields.creditsPerUsd']) or ['fields.creditsPerUsd'] != 1000
  or (['fields.ledgerStatus'] == 'new' and (tostring(['fields.pricingStatus']) != 'available' or isnull(amount) or not(isfinite(amount)) or amount < 0 or isempty(tostring(['fields.priceBasis'])) or isnull(tolong(['fields.grossCreditValueNanoUsd'])) or tolong(['fields.grossCreditValueNanoUsd']) < 0))
| summarize by incidentDay, accountingId
| summarize healthProblemCount = count() by incidentDay;
let identities = observations
| where isnotempty(accountingId) and ['fields.ledgerStatus'] in ('new', 'replay')
| summarize by accountingId, accountingAt, ['fields.model'], ['fields.inputTokens'], ['fields.outputTokens'], ['fields.cacheReadTokens'], ['fields.cacheCreationTokens']
| summarize variants = count() by accountingId
| where variants > 1
| summarize healthProblemCount = count()
| extend incidentDay = format_datetime(now(), 'yyyy-MM-dd');
let repriced = observations
| where isnotempty(accountingId) and ['fields.ledgerStatus'] == 'new'
| summarize by accountingId, ['fields.priceBasis'], ['fields.pricingStatus'], ['fields.grossCreditValueUsd'], ['fields.grossCreditValueNanoUsd']
| summarize variants = count() by accountingId
| where variants > 1
| summarize healthProblemCount = count()
| extend incidentDay = format_datetime(now(), 'yyyy-MM-dd');
let missingOriginal = observations
| where isnotempty(accountingId) and ['fields.ledgerStatus'] in ('new', 'replay')
| summarize originalCount = countif(['fields.ledgerStatus'] == 'new') by accountingId
| where originalCount == 0
| summarize healthProblemCount = count()
| extend incidentDay = format_datetime(now(), 'yyyy-MM-dd');
union invalid, identities, repriced, missingOriginal
| summarize healthProblemCount = sum(healthProblemCount) by incidentDay
