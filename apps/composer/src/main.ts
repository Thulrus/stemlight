import './style.css';
import { App } from './app';

// Dark by default; the theme toggle remembers a choice.
try {
  document.documentElement.dataset.theme = localStorage.getItem('stemlight-theme') ?? 'dark';
} catch {
  document.documentElement.dataset.theme = 'dark';
}

void new App(document.getElementById('app')!).route();
