// 宿主表单的最小类型面（各域 logic 读快照共用的入参形状）。
// 订阅与写入面（CardForm/FieldOp）在 useCardForm.ts。

/** 宿主表单快照（ConfigForm 的最小面，测试注入 fake）。 */
export interface FormSnapshot {
  readonly value?: Readonly<Record<string, unknown>> | undefined;
}
