/** Inline prompt revision with an explicit same-session restart action. */
import { useState } from 'react'
import { Button, IconInfoOutlineRegular, InlineEditor } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './PromptEditor.module.css'

/**
 * Render a retained draft; request failures keep its text available for retry.
 * @param props - Original text, task availability, submission callbacks, and localized labels.
 * @returns The inline prompt editor and its send/cancel controls.
 */
export function PromptEditor({ text, unavailable, onSend, onCancel, t }: {
  text: string
  unavailable: boolean
  onSend: (text: string) => Promise<void>
  onCancel: () => void
  t: ChatViewSlotProps['t']
}) {
  const [draft, setDraft] = useState(text)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = (): void => {
    if (sending || unavailable || draft.trim().length === 0) return
    setSending(true)
    setError(null)
    void onSend(draft).then(() => {
      onCancel()
    }, (failure: unknown) => {
      setError(failure instanceof Error ? failure.message : t('message.edit.failed'))
      setSending(false)
    })
  }
  return (
    <div className={css.editor} data-prompt-editor aria-busy={sending || undefined}>
      <fieldset className={css.fieldset} disabled={sending}>
        <InlineEditor value={draft} label={t('message.edit')} onChange={setDraft} onSave={send}
          onCancel={sending ? () => {} : onCancel} {...css.input === undefined ? {} : { className: css.input }} />
      </fieldset>
      <div className={css.footer}>
        <span className={css.notice}><IconInfoOutlineRegular size={16} aria-hidden />{t('message.edit.notice')}</span>
        <div className={css.buttons}>
          <Button variant="outline" disabled={sending} onClick={onCancel}>{t('message.edit.cancel')}</Button>
          <Button variant="primary" disabled={sending || unavailable || draft.trim().length === 0} onClick={send}>
            {sending ? t('message.edit.sending') : t('message.edit.send')}
          </Button>
        </div>
      </div>
      {unavailable && <p className={css.notice} role="status">{t('message.edit.unavailable')}</p>}
      {error !== null && <p className={css.error} role="alert">{error}</p>}
    </div>
  )
}
