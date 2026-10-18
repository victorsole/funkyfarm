import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { SessionProvider } from './auth';
import { I18nProvider } from './i18n';
import App from './App';
import { applyTheme, readTheme } from './theme';
import './fonts.css';
import './styles.css';

applyTheme(readTheme());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><BrowserRouter><I18nProvider><SessionProvider><App /></SessionProvider></I18nProvider></BrowserRouter></React.StrictMode>,
);
