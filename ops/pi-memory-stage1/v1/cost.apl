['vm0-web-logs-prod']
| extend context = ensure_field('fields.context', typeof(string)),
    operation = ensure_field('fields.operation', typeof(string)),
    billingMode = ensure_field('fields.billingMode', typeof(string)),
    costVersion = todouble(ensure_field('fields.costVersion', typeof(dynamic))),
    accountingId = ensure_field('fields.accountingId', typeof(string)),
    accountingAt = ensure_field('fields.accountingAt', typeof(string)),
    observedAtText = ensure_field('fields.observedAt', typeof(string)),
    ledgerStatus = ensure_field('fields.ledgerStatus', typeof(string)),
    pricingStatus = ensure_field('fields.pricingStatus', typeof(string)),
    priceBasis = ensure_field('fields.priceBasis', typeof(string)),
    grossCreditValueUsd = todouble(ensure_field('fields.grossCreditValueUsd', typeof(dynamic))),
    grossCreditValueNanoUsd = ensure_field('fields.grossCreditValueNanoUsd', typeof(string)),
    usageStatus = ensure_field('fields.usageStatus', typeof(string)),
    currency = ensure_field('fields.currency', typeof(string)),
    unit = ensure_field('fields.unit', typeof(string)),
    creditsPerUsd = todouble(ensure_field('fields.creditsPerUsd', typeof(dynamic)))
| where _time >= startofday(now()) - 2d and _time < now()
| where source == 'api' and level == 'info'
| where context == 'PiMemoryStage1Cost' and operation == 'pi_memory_stage1'
| where billingMode == 'builtin' and costVersion == 1
| extend accountingId = tostring(accountingId), accountingAt = todatetime(accountingAt), observedAt = todatetime(observedAtText)
| where ledgerStatus == 'new' and isnotempty(accountingId) and isnotnull(observedAt)
| extend observationOrder = strcat(tostring(observedAtText), '|', tostring(pricingStatus), '|', tostring(priceBasis), '|', tostring(grossCreditValueUsd), '|', tostring(grossCreditValueNanoUsd), '|', tostring(accountingAt), '|', tostring(usageStatus), '|', tostring(currency), '|', tostring(unit), '|', tostring(creditsPerUsd))
| summarize arg_min(observationOrder, accountingAt, usageStatus, pricingStatus, currency, unit, creditsPerUsd, grossCreditValueUsd, grossCreditValueNanoUsd) by accountingId
| where accountingAt >= startofday(now()) - 1d and accountingAt < startofday(now()) + 1d
| where usageStatus == 'valid' and pricingStatus == 'available'
| where currency == 'USD' and unit == 'gross_credit_value' and creditsPerUsd == 1000
| where isfinite(todouble(grossCreditValueUsd)) and todouble(grossCreditValueUsd) >= 0
| extend nanoUsd = tolong(grossCreditValueNanoUsd)
| where isnotnull(nanoUsd) and nanoUsd >= 0
| extend accountingDay = substring(tostring(startofday(accountingAt)), 0, 10)
// Axiom sum(long) returns float. Every partial sum is exact below this bound.
| summarize nanoUsd = sum(nanoUsd) by accountingDay
| where nanoUsd < 9007199254740991
| summarize grossCreditValueUsd = sum(nanoUsd) / 1000000000.0 by accountingDay
