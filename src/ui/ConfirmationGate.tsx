import { useState } from 'react'
import type { AppState } from './App.js'
import { PermissionCard } from './cards/PermissionCard.js'

interface Props {
  report:       any
  quote:        any
  parsedIntent: any
  state:        AppState
  onConfirm:    () => void
  onReset:      () => void
  language?:    string
}

/* ─── Static translations ────────────────────────────────────────────────── */

interface GateStrings {
  title:     string
  checkbox:  string
  cancel:    string
  proceed:   string
  rewriting: string
  hint:      string
  blocked:   string
}

const I18N: Record<string, GateStrings> = {
  en: {
    title:     'Confirmation Gate',
    checkbox:  'I have reviewed the Guardian report and understand the risks associated with this transaction.',
    cancel:    'Cancel',
    proceed:   'I UNDERSTAND — PROCEED →',
    rewriting: 'Rewriting…',
    hint:      'Check the acknowledgment above to enable the proceed button.',
    blocked:   'Guardian has blocked this swap. Click FIX IT FOR ME in the report above, or adjust your intent and re-analyze.',
  },
  fr: {
    title:     'Portail de confirmation',
    checkbox:  "J'ai examiné le rapport Guardian et je comprends les risques liés à cette transaction.",
    cancel:    'Annuler',
    proceed:   'JE COMPRENDS — CONTINUER →',
    rewriting: 'Réécriture…',
    hint:      'Cochez la case ci-dessus pour activer le bouton de confirmation.',
    blocked:   'Le Guardian a bloqué ce swap. Cliquez sur CORRIGER POUR MOI dans le rapport ci-dessus, ou ajustez votre intention et réanalysez.',
  },
  es: {
    title:     'Puerta de confirmación',
    checkbox:  'He revisado el informe Guardian y entiendo los riesgos asociados con esta transacción.',
    cancel:    'Cancelar',
    proceed:   'ENTIENDO — PROCEDER →',
    rewriting: 'Reescribiendo…',
    hint:      'Marque la casilla anterior para habilitar el botón de confirmación.',
    blocked:   'Guardian ha bloqueado este swap. Haga clic en CORREGIRLO POR MÍ en el informe anterior, o ajuste su intención y reanalice.',
  },
  pt: {
    title:     'Portal de confirmação',
    checkbox:  'Analisei o relatório Guardian e entendo os riscos associados a esta transação.',
    cancel:    'Cancelar',
    proceed:   'ENTENDI — PROSSEGUIR →',
    rewriting: 'Reescrevendo…',
    hint:      'Marque a caixa acima para ativar o botão de confirmação.',
    blocked:   'O Guardian bloqueou este swap. Clique em CORRIGIR POR MIM no relatório acima ou ajuste sua intenção e reanalise.',
  },
  yo: {
    title:     'Ẹnu-ọna Ìdánilójú',
    checkbox:  'Mo ti ṣe àyẹ̀wò ìjábọ̀ Guardian mo sì gbọ́ àwọn ewu tó ní í ṣe pẹ̀lú ìdúnàádúrà yìí.',
    cancel:    'Fagilé',
    proceed:   'MO GBÀ — TẸSÍWÁJÚ →',
    rewriting: 'Tún kọ…',
    hint:      'Ṣàyẹ̀wò àpótí ìmọ̀ tó wà lókè láti mú bọ́tìnì tẹsíwájú ṣiṣẹ́.',
    blocked:   'Guardian ti dá swap yìí dúró. Tẹ ṢÀTÚNṢE FÚN MI nínú ìjábọ̀ tó wà lókè, tàbí ṣàtúnṣe ìmọ̀-aifọwọyi rẹ kí o sì tún ṣàyẹ̀wò.',
  },
  ha: {
    title:     'Ƙofar Tabbatarwa',
    checkbox:  "Na duba rahoton Guardian kuma na fahimci haɗarin da ke da alaƙa da wannan ma'amalat.",
    cancel:    'Soke',
    proceed:   'NA FAHIMTA — CIGABA →',
    rewriting: 'Sake rubutawa…',
    hint:      'Bincike akwatin da ke sama don kunna maɓallin ci gaba.',
    blocked:   "Guardian ya toshe wannan musaya. Danna GYARA MINI a cikin rahoton da ke sama, ko gyara manufarku kuma sake bincika.",
  },
  ig: {
    title:     'Ọnụ Ụzọ Nkwenye',
    checkbox:  'Agụọla m akụkọ Guardian ma ghọta ihe ize ndụ jikọtara ya na azụmahịa a.',
    cancel:    'Kagbuo',
    proceed:   'ENWETARA M — GA N\'IHU →',
    rewriting: 'Na-edegharị…',
    hint:      'Tịa igbe dị n\'elu iji mee ka bọtọn n\'ihu arụọ ọrụ.',
    blocked:   'Guardian echegbula mgbanwe a. Pịa DỌZỊE MAKA M n\'akụkọ dị n\'elu, ma ọ bụ gbanwee ebumnuche gị wee nyochaa ọzọ.',
  },
  ar: {
    title:     'بوابة التأكيد',
    checkbox:  'لقد راجعت تقرير Guardian وأفهم المخاطر المرتبطة بهذه المعاملة.',
    cancel:    'إلغاء',
    proceed:   'أفهم — المتابعة →',
    rewriting: 'إعادة كتابة…',
    hint:      'حدد المربع أعلاه لتفعيل زر المتابعة.',
    blocked:   'قام Guardian بحظر هذه الصفقة. انقر على أصلحها لي في التقرير أعلاه، أو عدّل قصدك وأعد التحليل.',
  },
  zh: {
    title:     '确认关卡',
    checkbox:  '我已查阅Guardian报告，并了解此交易相关风险。',
    cancel:    '取消',
    proceed:   '我已知晓 — 继续 →',
    rewriting: '重写中…',
    hint:      '请勾选上方复选框以启用继续按钮。',
    blocked:   'Guardian已阻止此交易。请点击报告中的"为我修复"，或调整您的意图并重新分析。',
  },
  ja: {
    title:     '確認ゲート',
    checkbox:  'Guardianレポートを確認し、このトランザクションに関連するリスクを理解しました。',
    cancel:    'キャンセル',
    proceed:   '理解して進む →',
    rewriting: '書き直し中…',
    hint:      '上のチェックボックスをオンにして進むボタンを有効にしてください。',
    blocked:   'Guardianがこのスワップをブロックしました。上のレポートの「修正してもらう」をクリックするか、インテントを調整して再分析してください。',
  },
  de: {
    title:     'Bestätigungsgate',
    checkbox:  'Ich habe den Guardian-Bericht geprüft und verstehe die mit dieser Transaktion verbundenen Risiken.',
    cancel:    'Abbrechen',
    proceed:   'ICH VERSTEHE — FORTFAHREN →',
    rewriting: 'Wird neu geschrieben…',
    hint:      'Aktivieren Sie das Kontrollkästchen oben, um den Fortfahren-Button zu aktivieren.',
    blocked:   'Guardian hat diesen Swap blockiert. Klicken Sie im Bericht oben auf „FÜR MICH BEHEBEN" oder passen Sie Ihre Absicht an und analysieren Sie erneut.',
  },
  ko: {
    title:     '확인 게이트',
    checkbox:  'Guardian 보고서를 검토했으며 이 거래와 관련된 위험을 이해합니다.',
    cancel:    '취소',
    proceed:   '이해합니다 — 진행 →',
    rewriting: '다시 쓰는 중…',
    hint:      '위의 체크박스를 선택하여 진행 버튼을 활성화하세요.',
    blocked:   'Guardian이 이 스왑을 차단했습니다. 위 보고서에서 내 대신 수정 버튼을 클릭하거나 의도를 조정하고 다시 분석하세요.',
  },
  ru: {
    title:     'Ворота подтверждения',
    checkbox:  'Я ознакомился с отчётом Guardian и понимаю риски, связанные с этой транзакцией.',
    cancel:    'Отмена',
    proceed:   'ПОНЯЛ — ПРОДОЛЖИТЬ →',
    rewriting: 'Перезапись…',
    hint:      'Установите флажок выше, чтобы активировать кнопку продолжения.',
    blocked:   'Guardian заблокировал этот своп. Нажмите «ИСПРАВИТЬ ЗА МЕНЯ» в отчёте выше или измените намерение и повторите анализ.',
  },
  tr: {
    title:     'Onay Kapısı',
    checkbox:  'Guardian raporunu inceledim ve bu işlemle ilgili riskleri anlıyorum.',
    cancel:    'İptal',
    proceed:   'ANLADIM — İLERLE →',
    rewriting: 'Yeniden yazılıyor…',
    hint:      'Devam düğmesini etkinleştirmek için yukarıdaki onay kutusunu işaretleyin.',
    blocked:   "Guardian bu swapı engelledi. Yukarıdaki raporda BENIM İÇİN DÜZELT'e tıklayın veya niyetinizi ayarlayıp yeniden analiz edin.",
  },
  sw: {
    title:     'Lango la Uthibitisho',
    checkbox:  'Nimekagua ripoti ya Guardian na ninaelewa hatari zinazohusiana na muamala huu.',
    cancel:    'Ghairi',
    proceed:   'NAELEWA — ENDELEA →',
    rewriting: 'Kuandika upya…',
    hint:      'Angalia kisanduku hapo juu ili kuwezesha kitufe cha kuendelea.',
    blocked:   'Guardian imezuia ubadilishaji huu. Bonyeza NIREKEBISHA katika ripoti hapo juu, au rekebisha nia yako na uchanganue tena.',
  },
}

function t(lang: string | undefined): GateStrings {
  return I18N[lang ?? 'en'] ?? I18N['en']
}

/* ─── Component ──────────────────────────────────────────────────────────── */

export function ConfirmationGate({ report, quote, parsedIntent, state, onConfirm, onReset, language }: Props) {
  const [understood, setUnderstood] = useState(false)
  const s = t(language)

  const isRewriting = state === 'rewriting'
  const blocked     = !report.canProceed

  // Gate logic stays here; PermissionCard only renders the result.
  const flags: any[]    = report.flags ?? []
  const warnings        = flags.filter((f) => f.severity !== 'green')
  const needsAck        = warnings.length > 0
  const findings        = warnings.slice(0, 2).map((f) => ({
    title:    f.title ?? f.class ?? 'Risk',
    severity: f.severity ?? 'yellow',
    message:  f.message,
  }))
  const confirmDisabled = blocked || isRewriting || (needsAck && !understood)

  return (
    <PermissionCard
      title={s.title}
      summary={
        <>
          Swap{' '}
          <span className="text-white font-semibold">{quote.amountInFormatted} {parsedIntent.input_asset}</span>
          {' → '}
          <span className="text-white font-semibold">{quote.amountOutFormatted} {parsedIntent.output_goal?.toUpperCase()}</span>
        </>
      }
      level={report.level}
      score={report.score}
      routeLabel={quote.routeLabel}
      gasLabel={`~${quote.gasEstimateFormatted} SUI`}
      findings={findings}
      blocked={blocked}
      blockedMsg={s.blocked}
      needsAck={needsAck}
      acknowledged={understood}
      onToggleAck={() => setUnderstood(u => !u)}
      confirmDisabled={confirmDisabled}
      busy={isRewriting}
      labels={{ confirm: s.proceed, cancel: s.cancel, ack: s.checkbox, hint: s.hint, busy: s.rewriting }}
      onConfirm={onConfirm}
      onCancel={onReset}
    />
  )
}
