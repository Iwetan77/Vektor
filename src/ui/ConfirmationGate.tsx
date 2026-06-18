import { useState } from 'react'
import type { AppState } from './App.js'

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

  const levelEmoji: Record<string, string> = { LOW: '✅', MEDIUM: '⚠️', HIGH: '🔶', CRITICAL: '🚫' }
  const levelColor = ({
    LOW:      'text-emerald-400 border-emerald-500/30 bg-emerald-500/5',
    MEDIUM:   'text-amber-400   border-amber-500/30   bg-amber-500/5',
    HIGH:     'text-orange-400  border-orange-500/30  bg-orange-500/5',
    CRITICAL: 'text-red-400     border-red-500/30     bg-red-500/5',
  } as Record<string, string>)[report.level] ?? ''

  return (
    <div className={`rounded-xl border p-6 space-y-5 ${
      blocked ? 'border-red-500/20 bg-red-500/5' : 'border-[#1e1e2e] bg-[#111118]'
    }`}>
      <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest">{s.title}</h2>

      {/* Summary card */}
      <div className="rounded-lg bg-slate-900/60 border border-[#1e1e2e] px-5 py-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-400">
            Swap{' '}
            <span className="text-white font-semibold">{quote.amountInFormatted} {parsedIntent.input_asset}</span>
            {' → '}
            <span className="text-white font-semibold">{quote.amountOutFormatted} {parsedIntent.output_goal?.toUpperCase()}</span>
          </span>
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${levelColor}`}>
            {levelEmoji[report.level] ?? ''} {report.level}
          </span>
        </div>

        <div className="flex items-center gap-4 text-xs text-slate-500">
          <span>Guardian score: <span className="text-slate-300 font-mono">{report.score}/100</span></span>
          <span>Route: <span className="text-slate-300">{quote.routeLabel}</span></span>
          <span>Gas: <span className="text-slate-300 font-mono">~{quote.gasEstimateFormatted} SUI</span></span>
        </div>
      </div>

      {/* Blocked message */}
      {blocked && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          {s.blocked}
        </div>
      )}

      {/* Acknowledgment checkbox for non-blocked swaps with warnings */}
      {!blocked && report.flags.some((f: any) => f.severity !== 'green') && (
        <label className="flex items-start gap-3 cursor-pointer group">
          <div
            onClick={() => setUnderstood(u => !u)}
            className={`mt-0.5 w-5 h-5 shrink-0 rounded border flex items-center justify-center transition-colors cursor-pointer ${
              understood ? 'bg-indigo-600 border-indigo-500' : 'border-slate-600 group-hover:border-slate-400'
            }`}
          >
            {understood && (
              <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </div>
          <span className="text-sm text-slate-400">{s.checkbox}</span>
        </label>
      )}

      {/* Action buttons */}
      <div className="flex gap-3">
        <button
          onClick={onReset}
          className="px-4 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-sm font-medium transition-colors"
        >
          {s.cancel}
        </button>

        <button
          onClick={onConfirm}
          disabled={
            blocked ||
            isRewriting ||
            (report.flags.some((f: any) => f.severity !== 'green') && !understood)
          }
          className="flex-1 py-2.5 rounded-lg btn-proceed text-white text-sm font-bold disabled:opacity-30 disabled:cursor-not-allowed disabled:shadow-none transition-all flex items-center justify-center gap-2"
        >
          {isRewriting ? (
            <>
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="white" strokeWidth="4"/>
                <path className="opacity-75" fill="white" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
              </svg>
              {s.rewriting}
            </>
          ) : s.proceed}
        </button>
      </div>

      {!blocked && !understood && report.flags.some((f: any) => f.severity !== 'green') && (
        <p className="text-xs text-slate-600 text-center">{s.hint}</p>
      )}
    </div>
  )
}
