// 设置卡片的界面词条（与 iMessage 回复文案分开放：受众不同）。
//
// 只覆盖设置卡片自己的界面文字；产品名 iMessage 不翻译。
// 两种语言必须成对出现（有测试钉住），缺 key 会回退到另一语言。

export const settingsMessages = {
  zh: {
    localeLabel: '系统提示语言',
    localeHint: '仅决定系统提示消息（如会话切换通知）的语言，不改变 AI 回复的语言',
    allowlistLabel: '允许的联系人',
    allowlistHint: '手机号需含区号，如 +8613800000000',
    addNumber: '添加号码',
    confirmAdd: '添加',
    cancel: '取消',
    invalidNumber: '无法识别的号码（需含区号，如 +8613800000000）',
    duplicateNumber: '该号码已在列表中',
    removeEntry: '删除',
    chunkedLabel: '分段回复',
    chunkedHint: '开启后把回复拆成多条气泡并带拟人节奏；关闭则整段一条直接发送',
    maxChunksLabel: '最大分段数',
    maxChunksErrorText: '需为 1–50 的整数',
    delayFactorLabel: '延时系数',
    delayFactorHint: '0 = 分段但不延时',
    delayFactorErrorText: '需为 0–5 的数字（0 = 不延时）',
    emptyWarn: '白名单为空：所有消息都会被忽略',
    invalidWarn: '存在无法识别的号码，修好后才能保存',
    save: '保存',
    saving: '保存中…',
    loading: '加载中…',
    saveFailed: '保存失败，请重试',
  },
  en: {
    localeLabel: 'System message language',
    localeHint: 'Only sets the language of system notices (e.g. session-switched). AI replies are unaffected.',
    allowlistLabel: 'Allowed contacts',
    allowlistHint: 'Phone numbers need a country code, e.g. +8613800000000',
    addNumber: 'Add number',
    confirmAdd: 'Add',
    cancel: 'Cancel',
    invalidNumber: 'Not a valid phone number (needs country code, e.g. +8613800000000)',
    duplicateNumber: 'This number is already in the list',
    removeEntry: 'Remove',
    chunkedLabel: 'Chunked replies',
    chunkedHint: 'On: split replies into bubbles with human pacing. Off: send the whole reply as one message.',
    maxChunksLabel: 'Max chunks',
    maxChunksErrorText: 'Must be an integer between 1 and 50',
    delayFactorLabel: 'Delay factor',
    delayFactorHint: '0 = chunks without delay',
    delayFactorErrorText: 'Must be a number between 0 and 5 (0 = no delay)',
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
