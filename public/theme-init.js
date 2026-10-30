// Aplica o tema escolhido antes da tela aparecer (arquivo próprio: a política de segurança não permite script embutido)
try { var t = localStorage.getItem('rastro-tema'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
