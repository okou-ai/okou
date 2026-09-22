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
] as const;

export const localeResourceHandlers = localeResourceFixtures.map(
  ({ resource, url }) => {
    return http.get(url, () => {
      return HttpResponse.json(resource);
    });
  },
);
