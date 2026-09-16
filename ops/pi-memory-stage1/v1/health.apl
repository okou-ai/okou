let observations = ['vm0-web-logs-prod']
| extend context = ensure_field('fields.context', typeof(string)),
    operation = ensure_field('fields.operation', typeof(string)),
    billingMode = ensure_field('fields.billingMode', typeof(string)),
    accountingId = ensure_field('fields.accountingId', typeof(string)),
    accountingAt = ensure_field('fields.accountingAt', typeof(string)),
    observedAt = ensure_field('fields.observedAt', typeof(string)),
    grossCreditValueUsd = todouble(ensure_field('fields.grossCreditValueUsd', typeof(dynamic))),
    costVersion = todouble(ensure_field('fields.costVersion', typeof(dynamic))),
    usageStatus = ensure_field('fields.usageStatus', typeof(string)),
    ledgerStatus = ensure_field('fields.ledgerStatus', typeof(string)),
    inputTokens = todouble(ensure_field('fields.inputTokens', typeof(dynamic))),
    outputTokens = todouble(ensure_field('fields.outputTokens', typeof(dynamic))),
    cacheReadTokens = todouble(ensure_field('fields.cacheReadTokens', typeof(dynamic))),
    cacheCreationTokens = todouble(ensure_field('fields.cacheCreationTokens', typeof(dynamic))),
    pricingStatus = ensure_field('fields.pricingStatus', typeof(string)),
    grossCreditValueNanoUsd = ensure_field('fields.grossCreditValueNanoUsd', typeof(string)),
    currency = ensure_field('fields.currency', typeof(string)),
    unit = ensure_field('fields.unit', typeof(string)),
    creditsPerUsd = todouble(ensure_field('fields.creditsPerUsd', typeof(dynamic))),
    priceBasis = ensure_field('fields.priceBasis', typeof(string)),
    model = ensure_field('fields.model', typeof(string))
| where _time >= startofday(now()) - 2d and _time < now()
| where source == 'api' and level == 'info'
| where context == 'PiMemoryStage1Cost' and operation == 'pi_memory_stage1'
| where tostring(billingMode) != 'byok'
| extend accountingId = tostring(accountingId), accountingAt = todatetime(accountingAt), observedAt = todatetime(observedAt), amount = todouble(grossCreditValueUsd)
| extend incidentDay = substring(tostring(startofday(_time)), 0, 10);
let invalid = observations
| where tostring(billingMode) != 'builtin' or isnull(costVersion) or costVersion != 1 or tostring(usageStatus) != 'valid'
  or tostring(ledgerStatus) !in ('new', 'replay', 'legacy_replay', 'zero_usage', 'persistence_error', 'not_recorded')
  or isnull(tolong(inputTokens)) or isnull(tolong(outputTokens)) or isnull(tolong(cacheReadTokens)) or isnull(tolong(cacheCreationTokens))
  or todouble(inputTokens) < 0 or todouble(outputTokens) < 0 or todouble(cacheReadTokens) < 0 or todouble(cacheCreationTokens) < 0
  or todouble(inputTokens) != tolong(inputTokens) or todouble(outputTokens) != tolong(outputTokens)
  or todouble(cacheReadTokens) != tolong(cacheReadTokens) or todouble(cacheCreationTokens) != tolong(cacheCreationTokens)
  or (ledgerStatus == 'zero_usage' and (todouble(inputTokens) + todouble(outputTokens) + todouble(cacheReadTokens) + todouble(cacheCreationTokens) != 0))
  or (ledgerStatus in ('replay', 'zero_usage') and (tostring(pricingStatus) != tostring(ledgerStatus) or isnotnull(grossCreditValueUsd) or isnotnull(grossCreditValueNanoUsd)))
  or ledgerStatus in ('persistence_error', 'legacy_replay', 'not_recorded')
  or (ledgerStatus !in ('byok', 'zero_usage') and (isempty(accountingId) or isnull(accountingAt) or isnull(observedAt)))
  or tostring(currency) != 'USD' or tostring(unit) != 'gross_credit_value' or isnull(creditsPerUsd) or creditsPerUsd != 1000
  or (ledgerStatus == 'new' and (tostring(pricingStatus) != 'available' or isnull(amount) or not(isfinite(amount)) or amount < 0 or isempty(tostring(priceBasis)) or isnull(tolong(grossCreditValueNanoUsd)) or tolong(grossCreditValueNanoUsd) < 0))
| summarize by incidentDay, accountingId
| summarize healthProblemCount = count() by incidentDay;
let identities = observations
| where isnotempty(accountingId) and ledgerStatus in ('new', 'replay')
| summarize by accountingId, accountingAt, model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens
| summarize variants = count() by accountingId
| where variants > 1
| summarize healthProblemCount = count()
| extend incidentDay = substring(tostring(startofday(now())), 0, 10);
let repriced = observations
| where isnotempty(accountingId) and ledgerStatus == 'new'
| summarize by accountingId, priceBasis, pricingStatus, grossCreditValueUsd, grossCreditValueNanoUsd
| summarize variants = count() by accountingId
| where variants > 1
| summarize healthProblemCount = count()
| extend incidentDay = substring(tostring(startofday(now())), 0, 10);
let missingOriginal = observations
| where isnotempty(accountingId) and ledgerStatus in ('new', 'replay')
| summarize originalCount = countif(ledgerStatus == 'new') by accountingId
| where originalCount == 0
| summarize healthProblemCount = count()
| extend incidentDay = substring(tostring(startofday(now())), 0, 10);
// Conservative precision coverage: repeated identical facts cannot inflate it.
// Conflicting facts already raise identity/repricing health independently.
let precision = observations
| where ledgerStatus == 'new' and isnotempty(accountingId)
| extend nanoUsd = tolong(grossCreditValueNanoUsd)
| where isnotnull(nanoUsd) and nanoUsd >= 0
| summarize by accountingId, accountingAt, nanoUsd
| summarize nanoTotal = sum(nanoUsd) by accountingDay = startofday(accountingAt)
| where nanoTotal >= 9007199254740991
| summarize healthProblemCount = count()
| extend incidentDay = substring(tostring(startofday(now())), 0, 10);
union invalid, identities, repriced, missingOriginal, precision
| summarize healthProblemCount = sum(healthProblemCount) by incidentDay
