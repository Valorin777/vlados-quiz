// «Тип вопроса»: three big chrome tabs on top of the editor. A chrome thumb slides to the picked
// one; converting the question itself is the editor's job (model.ts convertQuestion).

import type { QuestionType } from '@shared/types';
import type { CSSProperties } from 'react';
import { audio, cx } from '../../../visual';
import { Icon } from '../ui/icons';
import { QUESTION_TYPES, TYPE_UI } from './model';
import './questions.css';

export function TypeSwitch({ value, onChange }: { value: QuestionType; onChange: (t: QuestionType) => void }) {
  const at = QUESTION_TYPES.indexOf(value);
  return (
    <div className="ad-qt-wrap">
      <div className="ad-qt" role="radiogroup" aria-label="Тип вопроса" style={{ '--qt-i': at } as CSSProperties}>
        <span className="ad-qt-thumb" aria-hidden />
        {QUESTION_TYPES.map((t) => {
          const on = t === value;
          const ui = TYPE_UI[t];
          return (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={on}
              className={cx('ad-qt-tab', on && 'is-on')}
              title={ui.line}
              onClick={() => {
                if (on) return;
                audio.drop(1.2, 0.14);
                onChange(t);
              }}
            >
              <span className="ad-qt-ico">
                <Icon name={ui.icon} size={19} />
              </span>
              <span className="ad-qt-txt">
                <b>{ui.label}</b>
                <small>{ui.line}</small>
              </span>
            </button>
          );
        })}
      </div>
      <p className="ad-qt-line" aria-hidden>
        {TYPE_UI[value].line}
      </p>
    </div>
  );
}
