import { http, HttpResponse } from "msw";

import deDEAgents from "../../i18n/locales/de-DE/agents.json";
import deDEAgentsUrl from "../../i18n/locales/de-DE/agents.json?url";
import deDECommon from "../../i18n/locales/de-DE/common.json";
import deDECommonUrl from "../../i18n/locales/de-DE/common.json?url";
import esESAgents from "../../i18n/locales/es-ES/agents.json";
import esESAgentsUrl from "../../i18n/locales/es-ES/agents.json?url";
import esESCommon from "../../i18n/locales/es-ES/common.json";
import esESCommonUrl from "../../i18n/locales/es-ES/common.json?url";
import frFRAgents from "../../i18n/locales/fr-FR/agents.json";
import frFRAgentsUrl from "../../i18n/locales/fr-FR/agents.json?url";
import frFRCommon from "../../i18n/locales/fr-FR/common.json";
import frFRCommonUrl from "../../i18n/locales/fr-FR/common.json?url";
import hiINAgents from "../../i18n/locales/hi-IN/agents.json";
import hiINAgentsUrl from "../../i18n/locales/hi-IN/agents.json?url";
import hiINCommon from "../../i18n/locales/hi-IN/common.json";
import hiINCommonUrl from "../../i18n/locales/hi-IN/common.json?url";
import idIDAgents from "../../i18n/locales/id-ID/agents.json";
import idIDAgentsUrl from "../../i18n/locales/id-ID/agents.json?url";
import idIDCommon from "../../i18n/locales/id-ID/common.json";
import idIDCommonUrl from "../../i18n/locales/id-ID/common.json?url";
import itITAgents from "../../i18n/locales/it-IT/agents.json";
import itITAgentsUrl from "../../i18n/locales/it-IT/agents.json?url";
import itITCommon from "../../i18n/locales/it-IT/common.json";
import itITCommonUrl from "../../i18n/locales/it-IT/common.json?url";
import jaJPAgents from "../../i18n/locales/ja-JP/agents.json";
import jaJPAgentsUrl from "../../i18n/locales/ja-JP/agents.json?url";
import jaJPCommon from "../../i18n/locales/ja-JP/common.json";
import jaJPCommonUrl from "../../i18n/locales/ja-JP/common.json?url";
import koKRAgents from "../../i18n/locales/ko-KR/agents.json";
import koKRAgentsUrl from "../../i18n/locales/ko-KR/agents.json?url";
import koKRCommon from "../../i18n/locales/ko-KR/common.json";
import koKRCommonUrl from "../../i18n/locales/ko-KR/common.json?url";
import ptBRAgents from "../../i18n/locales/pt-BR/agents.json";
import ptBRAgentsUrl from "../../i18n/locales/pt-BR/agents.json?url";
import ptBRCommon from "../../i18n/locales/pt-BR/common.json";
import ptBRCommonUrl from "../../i18n/locales/pt-BR/common.json?url";
import zhHansAgents from "../../i18n/locales/zh-Hans/agents.json";
import zhHansAgentsUrl from "../../i18n/locales/zh-Hans/agents.json?url";
import zhHansCommon from "../../i18n/locales/zh-Hans/common.json";
import zhHansCommonUrl from "../../i18n/locales/zh-Hans/common.json?url";
import zhHantAgents from "../../i18n/locales/zh-Hant/agents.json";
import zhHantAgentsUrl from "../../i18n/locales/zh-Hant/agents.json?url";
import zhHantCommon from "../../i18n/locales/zh-Hant/common.json";
import zhHantCommonUrl from "../../i18n/locales/zh-Hant/common.json?url";

import trTRAgents from "../../i18n/locales/tr-TR/agents.json";
import trTRAgentsUrl from "../../i18n/locales/tr-TR/agents.json?url";
import trTRCommon from "../../i18n/locales/tr-TR/common.json";
import trTRCommonUrl from "../../i18n/locales/tr-TR/common.json?url";
import viVNAgents from "../../i18n/locales/vi-VN/agents.json";
import viVNAgentsUrl from "../../i18n/locales/vi-VN/agents.json?url";
import viVNCommon from "../../i18n/locales/vi-VN/common.json";
import viVNCommonUrl from "../../i18n/locales/vi-VN/common.json?url";
import thTHAgents from "../../i18n/locales/th-TH/agents.json";
import thTHAgentsUrl from "../../i18n/locales/th-TH/agents.json?url";
import thTHCommon from "../../i18n/locales/th-TH/common.json";
import thTHCommonUrl from "../../i18n/locales/th-TH/common.json?url";
import nlNLAgents from "../../i18n/locales/nl-NL/agents.json";
import nlNLAgentsUrl from "../../i18n/locales/nl-NL/agents.json?url";
import nlNLCommon from "../../i18n/locales/nl-NL/common.json";
import nlNLCommonUrl from "../../i18n/locales/nl-NL/common.json?url";
import svSEAgents from "../../i18n/locales/sv-SE/agents.json";
import svSEAgentsUrl from "../../i18n/locales/sv-SE/agents.json?url";
import svSECommon from "../../i18n/locales/sv-SE/common.json";
import svSECommonUrl from "../../i18n/locales/sv-SE/common.json?url";
import daDKAgents from "../../i18n/locales/da-DK/agents.json";
import daDKAgentsUrl from "../../i18n/locales/da-DK/agents.json?url";
import daDKCommon from "../../i18n/locales/da-DK/common.json";
import daDKCommonUrl from "../../i18n/locales/da-DK/common.json?url";
import nbNOAgents from "../../i18n/locales/nb-NO/agents.json";
import nbNOAgentsUrl from "../../i18n/locales/nb-NO/agents.json?url";
import nbNOCommon from "../../i18n/locales/nb-NO/common.json";
import nbNOCommonUrl from "../../i18n/locales/nb-NO/common.json?url";
import fiFIAgents from "../../i18n/locales/fi-FI/agents.json";
import fiFIAgentsUrl from "../../i18n/locales/fi-FI/agents.json?url";
import fiFICommon from "../../i18n/locales/fi-FI/common.json";
import fiFICommonUrl from "../../i18n/locales/fi-FI/common.json?url";
import heILAgents from "../../i18n/locales/he-IL/agents.json";
import heILAgentsUrl from "../../i18n/locales/he-IL/agents.json?url";
import heILCommon from "../../i18n/locales/he-IL/common.json";
import heILCommonUrl from "../../i18n/locales/he-IL/common.json?url";
import plPLAgents from "../../i18n/locales/pl-PL/agents.json";
import plPLAgentsUrl from "../../i18n/locales/pl-PL/agents.json?url";
import plPLCommon from "../../i18n/locales/pl-PL/common.json";
import plPLCommonUrl from "../../i18n/locales/pl-PL/common.json?url";
import csCZAgents from "../../i18n/locales/cs-CZ/agents.json";
import csCZAgentsUrl from "../../i18n/locales/cs-CZ/agents.json?url";
import csCZCommon from "../../i18n/locales/cs-CZ/common.json";
import csCZCommonUrl from "../../i18n/locales/cs-CZ/common.json?url";

const localeResourceFixtures = [
  { resource: deDEAgents, url: deDEAgentsUrl },
  { resource: deDECommon, url: deDECommonUrl },
  { resource: esESAgents, url: esESAgentsUrl },
  { resource: esESCommon, url: esESCommonUrl },
  { resource: frFRAgents, url: frFRAgentsUrl },
  { resource: frFRCommon, url: frFRCommonUrl },
  { resource: hiINAgents, url: hiINAgentsUrl },
  { resource: hiINCommon, url: hiINCommonUrl },
  { resource: idIDAgents, url: idIDAgentsUrl },
  { resource: idIDCommon, url: idIDCommonUrl },
  { resource: itITAgents, url: itITAgentsUrl },
  { resource: itITCommon, url: itITCommonUrl },
  { resource: jaJPAgents, url: jaJPAgentsUrl },
  { resource: jaJPCommon, url: jaJPCommonUrl },
  { resource: koKRAgents, url: koKRAgentsUrl },
  { resource: koKRCommon, url: koKRCommonUrl },
  { resource: ptBRAgents, url: ptBRAgentsUrl },
  { resource: ptBRCommon, url: ptBRCommonUrl },
  { resource: zhHansAgents, url: zhHansAgentsUrl },
  { resource: zhHansCommon, url: zhHansCommonUrl },
  { resource: zhHantAgents, url: zhHantAgentsUrl },
  { resource: zhHantCommon, url: zhHantCommonUrl },
  { resource: trTRAgents, url: trTRAgentsUrl },
  { resource: trTRCommon, url: trTRCommonUrl },
  { resource: viVNAgents, url: viVNAgentsUrl },
  { resource: viVNCommon, url: viVNCommonUrl },
  { resource: thTHAgents, url: thTHAgentsUrl },
  { resource: thTHCommon, url: thTHCommonUrl },
  { resource: nlNLAgents, url: nlNLAgentsUrl },
  { resource: nlNLCommon, url: nlNLCommonUrl },
  { resource: svSEAgents, url: svSEAgentsUrl },
  { resource: svSECommon, url: svSECommonUrl },
  { resource: daDKAgents, url: daDKAgentsUrl },
  { resource: daDKCommon, url: daDKCommonUrl },
  { resource: nbNOAgents, url: nbNOAgentsUrl },
  { resource: nbNOCommon, url: nbNOCommonUrl },
  { resource: fiFIAgents, url: fiFIAgentsUrl },
  { resource: fiFICommon, url: fiFICommonUrl },
  { resource: heILAgents, url: heILAgentsUrl },
  { resource: heILCommon, url: heILCommonUrl },
  { resource: plPLAgents, url: plPLAgentsUrl },
  { resource: plPLCommon, url: plPLCommonUrl },
  { resource: csCZAgents, url: csCZAgentsUrl },
  { resource: csCZCommon, url: csCZCommonUrl },
] as const;

export const localeResourceHandlers = localeResourceFixtures.map(
  ({ resource, url }) => {
    return http.get(url, () => {
      return HttpResponse.json(resource);
    });
  },
);
