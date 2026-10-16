import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import catalogue from '../../../locales/interface.json';

export type Language = keyof typeof catalogue.languages;
// Keep keys explicit so component authors cannot silently invent untranslated labels.
export type TranslationKey =
  | `nav.${'home' | 'requests' | 'documents' | 'farm' | 'reports' | 'guidance' | 'settings' | 'imports' | 'advisers' | 'community' | 'recordWork' | 'fields' | 'paperwork' | 'connections'}`
  | `auth.${'signIn' | 'createAccount' | 'email' | 'password' | 'displayName' | 'signOut'}`
  | `common.${'loading' | 'save' | 'cancel' | 'back' | 'next' | 'search' | 'edit' | 'delete' | 'add' | 'retry' | 'confirm' | 'approve' | 'download' | 'upload' | 'scan' | 'view' | 'close' | 'country' | 'language' | 'reportingYear'}`
  | `status.${'draft' | 'proposed' | 'confirmed' | 'rejected' | 'missing' | 'complete' | 'waiting' | 'offline' | 'syncing' | 'conflict'}`
  | `review.${'checkEvidence' | 'missingEvidence' | 'required'}`
  | `error.${'saveFailed' | 'loadFailed'}`
  | 'language.draftNotice';

export const languages = Object.entries(catalogue.languages).map(([code, entry]) => ({ code: code as Language, name: entry.name }));
const storageKey = 'funkyfarm.interfaceLanguage';
const translations = new Map<Language, Map<string, string>>();
for (const { code } of languages) {
  const labels = catalogue.languages[code].labels.split(catalogue.metadata.separator);
  if (labels.length !== catalogue.keys.length || labels.some(label => !label.trim())) {
    throw new Error(`Incomplete interface translation catalogue: ${code}`);
  }
  translations.set(code, new Map(catalogue.keys.map((key, index) => [key, labels[index]])));
  for (const [key, labelsByLanguage] of Object.entries(catalogue.additional)) {
    const value = labelsByLanguage[code];
    if (!value?.trim()) throw new Error(`Incomplete interface translation: ${code}/${key}`);
    translations.get(code)!.set(key, value);
  }
}

function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && Object.hasOwn(catalogue.languages, value);
}

function initialLanguage(): Language {
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (isLanguage(saved)) return saved;
  } catch { /* Language selection remains usable without persistent storage. */ }
  if (typeof navigator !== 'undefined') {
    for (const preferred of navigator.languages ?? [navigator.language]) {
      const code = preferred.toLowerCase().split('-')[0];
      if (isLanguage(code)) return code;
    }
  }
  return 'en';
}

type I18n = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey) => string;
  languages: typeof languages;
  translationStatus: 'draft';
};
const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, updateLanguage] = useState<Language>(initialLanguage);
  const setLanguage = useCallback((next: Language) => {
    if (!isLanguage(next)) return;
    updateLanguage(next);
    try { window.localStorage.setItem(storageKey, next); } catch { /* In-memory choice still applies. */ }
  }, []);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  const value = useMemo<I18n>(() => ({
    language, setLanguage, languages, translationStatus: 'draft',
    t: key => translations.get(language)?.get(key) ?? `[${key}]`,
  }), [language, setLanguage]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n requires I18nProvider.');
  return context;
}

export function Text({ id }: { id: TranslationKey }) {
  const { t } = useI18n();
  return <>{t(id)}</>;
}
