['vm0-web-logs-prod']
| where _time >= startofday(now()) - 2d and _time < now()
| where source == 'api' and level == 'info'
| where ['fields.context'] == 'PiMemoryStage1Cost' and ['fields.operation'] == 'pi_memory_stage1'
| where ['fields.billingMode'] == 'builtin' and ['fields.costVersion'] == 1
| extend accountingId = tostring(['fields.accountingId']), accountingAt = todatetime(['fields.accountingAt']), observedAt = todatetime(['fields.observedAt'])
| where ['fields.ledgerStatus'] == 'new' and isnotempty(accountingId) and isnotnull(observedAt)
| extend observationOrder = strcat(tostring(['fields.observedAt']), '|', tostring(['fields.pricingStatus']), '|', tostring(['fields.priceBasis']), '|', tostring(['fields.grossCreditValueUsd']), '|', tostring(['fields.grossCreditValueNanoUsd']))
| summarize arg_min(observationOrder, *) by accountingId
| where accountingAt >= startofday(now()) - 1d and accountingAt < startofday(now()) + 1d
| where ['fields.usageStatus'] == 'valid' and ['fields.pricingStatus'] == 'available'
| where ['fields.currency'] == 'USD' and ['fields.unit'] == 'gross_credit_value' and ['fields.creditsPerUsd'] == 1000
| where isfinite(todouble(['fields.grossCreditValueUsd'])) and todouble(['fields.grossCreditValueUsd']) >= 0
| extend nanoUsd = tolong(['fields.grossCreditValueNanoUsd'])
| where isnotnull(nanoUsd) and nanoUsd >= 0
| extend accountingDay = format_datetime(accountingAt, 'yyyy-MM-dd')
| summarize grossCreditValueUsd = sum(nanoUsd) / 1000000000.0 by accountingDay
