// 设置卡片的界面词条（与 iMessage 回复文案分开放：受众不同）。
//
// 只覆盖设置卡片自己的界面文字；产品名 iMessage 不翻译。
// 两种语言必须成对出现（有测试钉住），缺 key 会回退到另一语言。

export const settingsMessages = {
  zh: {
    localeLabel: '回复语言',
    allowlistLabel: '允许的联系人',
    allowlistHint: '一行一个手机号（含区号），留空则谁都不回复',
    emptyWarn: '白名单为空：所有消息都会被忽略',
    invalidWarn: '存在无法识别的号码，修好后才能保存',
    save: '保存',
    saving: '保存中…',
    loading: '加载中…',
    saveFailed: '保存失败，请重试',
  },
  en: {
    localeLabel: 'Reply language',
    allowlistLabel: 'Allowed contacts',
    allowlistHint: 'One phone number per line (with country code). Empty rejects everyone.',
    emptyWarn: 'Empty allowlist: every message will be ignored',
    invalidWarn: 'Some numbers cannot be parsed; fix them before saving',
    save: 'Save',
    saving: 'Saving…',
    loading: 'Loading…',
    saveFailed: 'Save failed, please retry',
  },
} as const;

export type SettingsMessages = Record<keyof (typeof settingsMessages)['zh'], string>;

/** 取某语言的词条（未知语言回退 zh，与 core i18n 的收窄方向一致）。 */
export function settingsTexts(locale: string | undefined): SettingsMessages {
  const table = locale === 'en' ? settingsMessages.en : settingsMessages.zh;
  return { ...table };
}
