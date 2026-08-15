const titles = {
  dashboard: 'Panel general',
  lots: 'Lotes',
  contracts: 'Contratos',
  customers: 'Clientes',
  receipts: 'Recibos'
};

const primaryActionLabels = {
  dashboard: 'Nuevo contrato',
  lots: 'Nuevo lote',
  contracts: 'Nuevo contrato',
  customers: 'Nuevo cliente',
  receipts: 'Nueva transacción'
};

const entityForms = {
  lots: {
    title: 'Nuevo lote',
    description: 'Ingresa la información del lote para agregarlo al inventario.',
    submitLabel: 'Guardar lote',
    fields: [
      { name: 'lot', label: 'Lote', placeholder: 'Ej. A-21', required: true },
      {
        name: 'project',
        label: 'Proyecto',
        type: 'select',
        placeholder: 'Selecciona un proyecto',
        options: ['Proyecto Santiago Etapa 1', 'Proyecto Santiago Etapa 2', 'Valle Verde', 'Monte Real'],
        required: true
      },
      { name: 'area', label: 'Área', type: 'number', placeholder: 'Ej. 320', min: '1', step: '0.01', hint: 'Valor en metros cuadrados (m²)', required: true },
      { name: 'basePrice', label: 'Precio base', type: 'number', placeholder: 'Ej. 185000', min: '0', step: '0.01', currency: true, required: true },
      { name: 'status', label: 'Estado', type: 'select', options: ['Disponible', 'Reservado', 'Vendido'], fullWidth: true, required: true }
    ]
  },
  contracts: {
    title: 'Nuevo contrato',
    description: 'Registra los datos principales del acuerdo con el cliente.',
    submitLabel: 'Guardar contrato',
    fields: [
      { name: 'customer', label: 'Cliente', placeholder: 'Nombre completo', fullWidth: true, required: true },
      { name: 'lot', label: 'Lote', placeholder: 'Ej. A-21', required: true },
      { name: 'finalPrice', label: 'Precio final', type: 'number', placeholder: 'Ej. 185000', min: '0', step: '0.01', currency: true, required: true },
      { name: 'paid', label: 'Monto pagado', type: 'number', placeholder: 'Ej. 25000', min: '0', step: '0.01', currency: true, required: true },
      { name: 'status', label: 'Estado', type: 'select', options: ['Al día', 'Sin pago', 'En riesgo', 'Pagado'], required: true }
    ]
  },
  customers: {
    title: 'Nuevo cliente',
    description: 'Agrega la información de contacto de un nuevo cliente.',
    submitLabel: 'Guardar cliente',
    fields: [
      { name: 'customer', label: 'Nombre completo', placeholder: 'Ej. Andrea López', fullWidth: true, required: true },
      { name: 'phone', label: 'Teléfono', type: 'tel', placeholder: 'Ej. 9999-0000', required: true },
      { name: 'since', label: 'Cliente desde', type: 'number', placeholder: 'Ej. 2026', min: '2000', max: '2100', required: true }
    ]
  },
  receipts: {
    title: 'Nueva transacción',
    description: 'Registra un pago y genera su entrada en la lista de recibos.',
    submitLabel: 'Guardar transacción',
    fields: [
      { name: 'customer', label: 'Cliente', placeholder: 'Nombre completo', fullWidth: true, required: true },
      { name: 'lot', label: 'Lote', placeholder: 'Ej. A-21', required: true },
      { name: 'paymentType', label: 'Tipo de pago', type: 'select', options: ['Abono', 'Prima', 'Pago final'], required: true },
      { name: 'method', label: 'Método', type: 'select', options: ['Efectivo', 'Transferencia', 'Tarjeta'], required: true },
      { name: 'amount', label: 'Monto recibido', type: 'number', placeholder: 'Ej. 3500', min: '0.01', step: '0.01', currency: true, required: true },
      { name: 'date', label: 'Fecha', type: 'date', required: true }
    ]
  }
};

// Create and inject the overlay for mobile
const overlay = document.createElement('div');
overlay.className = 'sidebar-overlay';
document.body.appendChild(overlay);

const sidebar = document.getElementById('sidebar');
const menuBtn = document.getElementById('menuBtn');
const primaryActionLabel = document.getElementById('primaryActionLabel');
const primaryActionButton = document.getElementById('primaryActionButton');
const entityModal = document.getElementById('entityModal');
const entityForm = document.getElementById('entityForm');
const entityFormFields = document.getElementById('entityFormFields');
const entityModalTitle = document.getElementById('entityModalTitle');
const entityModalDescription = document.getElementById('entityModalDescription');
const entitySubmitButton = document.getElementById('entitySubmitButton');
const closeEntityModalButton = document.getElementById('closeEntityModal');
const cancelEntityModalButton = document.getElementById('cancelEntityModal');

let activeTab = 'dashboard';
let activeFormType = 'contracts';
let previouslyFocusedElement = null;

function toggleMenu() {
  sidebar.classList.toggle('open');
  overlay.classList.toggle('show');
}

function closeMenu() {
  sidebar.classList.remove('open');
  overlay.classList.remove('show');
}

// Toggle menu events
if (window.matchMedia('(max-width:760px)').matches) { menuBtn.style.display = 'flex'; }

menuBtn.addEventListener('click', toggleMenu);
overlay.addEventListener('click', closeMenu);

// Navigation logic
document.querySelectorAll('.nav-item').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.nav-item').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');

    var tab = btn.getAttribute('data-tab');
    activeTab = tab;
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
    document.getElementById('tab-' + tab).classList.add('active');
    document.getElementById('pageTitle').textContent = titles[tab];
    primaryActionLabel.textContent = primaryActionLabels[tab];

    // Auto-close menu on mobile after selection
    if (sidebar.classList.contains('open')) { closeMenu(); }
  });
});

function createFormField(field) {
  const wrapper = document.createElement('div');
  wrapper.className = 'form-field' + (field.fullWidth ? ' full-width' : '');

  const label = document.createElement('label');
  label.htmlFor = 'entity-' + field.name;
  label.textContent = field.label;
  if (field.required) {
    const requiredMark = document.createElement('span');
    requiredMark.className = 'required-mark';
    requiredMark.textContent = ' *';
    requiredMark.setAttribute('aria-hidden', 'true');
    label.appendChild(requiredMark);
  }

  let control;
  if (field.type === 'select') {
    control = document.createElement('select');
    if (field.placeholder) {
      const placeholderOption = document.createElement('option');
      placeholderOption.value = '';
      placeholderOption.textContent = field.placeholder;
      placeholderOption.disabled = true;
      placeholderOption.selected = true;
      control.appendChild(placeholderOption);
    }
    field.options.forEach(function (optionLabel) {
      const option = document.createElement('option');
      option.value = optionLabel;
      option.textContent = optionLabel;
      control.appendChild(option);
    });
  } else {
    control = document.createElement('input');
    control.type = field.type || 'text';
    if (field.type === 'number') { control.inputMode = 'decimal'; }
    if (field.placeholder) { control.placeholder = field.placeholder; }
    if (field.min) { control.min = field.min; }
    if (field.max) { control.max = field.max; }
    if (field.step) { control.step = field.step; }
  }

  control.id = 'entity-' + field.name;
  control.name = field.name;
  control.required = Boolean(field.required);

  wrapper.appendChild(label);

  if (field.currency) {
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'input-with-prefix';
    const prefix = document.createElement('span');
    prefix.className = 'currency-prefix';
    prefix.textContent = document.querySelector('.currency-toggle button.on').dataset.cur === 'usd' ? '$' : 'L.';
    inputWrapper.append(prefix, control);
    wrapper.appendChild(inputWrapper);
  } else {
    wrapper.appendChild(control);
  }

  if (field.hint) {
    const hint = document.createElement('span');
    hint.className = 'field-hint';
    hint.textContent = field.hint;
    wrapper.appendChild(hint);
  }

  return wrapper;
}

function openEntityModal() {
  activeFormType = activeTab === 'dashboard' ? 'contracts' : activeTab;
  const formConfig = entityForms[activeFormType];
  if (!formConfig) { return; }

  previouslyFocusedElement = document.activeElement;
  entityFormFields.replaceChildren(...formConfig.fields.map(createFormField));
  entityModalTitle.textContent = formConfig.title;
  entityModalDescription.textContent = formConfig.description;
  entitySubmitButton.textContent = formConfig.submitLabel;

  if (activeFormType === 'receipts') {
    entityForm.elements.date.value = new Date().toISOString().slice(0, 10);
  }

  entityModal.classList.add('show');
  entityModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  requestAnimationFrame(function () {
    const firstControl = entityForm.querySelector('input, select');
    if (firstControl) { firstControl.focus(); }
  });
}

function closeEntityModal() {
  entityModal.classList.remove('show');
  entityModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  entityForm.reset();
  entityForm.classList.remove('was-validated');
  if (previouslyFocusedElement) { previouslyFocusedElement.focus(); }
}

primaryActionButton.addEventListener('click', openEntityModal);
closeEntityModalButton.addEventListener('click', closeEntityModal);
cancelEntityModalButton.addEventListener('click', closeEntityModal);
entityModal.addEventListener('click', function (event) {
  if (event.target === entityModal) { closeEntityModal(); }
});

document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && entityModal.classList.contains('show')) {
    closeEntityModal();
  }
});

function showValidationErrors() {
  entityForm.classList.add('was-validated');
  const modalPanel = entityModal.querySelector('.entity-modal');
  modalPanel.classList.remove('validation-shake');
  requestAnimationFrame(function () {
    modalPanel.classList.add('validation-shake');
  });
}

entityForm.addEventListener('input', function () {
  if (!entityForm.querySelector(':invalid')) {
    entityForm.classList.remove('was-validated');
  }
});

entityForm.addEventListener('keydown', function (event) {
  if (event.target.matches('input[type="number"]') && ['e', 'E', '+', '-'].includes(event.key)) {
    event.preventDefault();
  }
});

entityForm.addEventListener('beforeinput', function (event) {
  if (event.target.matches('input[type="number"]') && event.data && /[eE+\-]/.test(event.data)) {
    event.preventDefault();
  }
});

function formatCurrency(value) {
  return 'L. ' + Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function createCell(text, className) {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) { cell.className = className; }
  return cell;
}

function createAmountCell(value, extraClass) {
  const lps = formatCurrency(value);
  const usd = '$ ' + Math.round(Number(value) / 24.7).toLocaleString('en-US');
  const cell = createCell(lps, 'mono amount' + (extraClass ? ' ' + extraClass : ''));
  cell.dataset.lps = lps;
  cell.dataset.usd = usd;
  if (document.querySelector('.currency-toggle button.on').dataset.cur === 'usd') {
    cell.textContent = usd;
  }
  return cell;
}

function createStatusStamp(status) {
  const classByStatus = {
    Disponible: 'success',
    Reservado: 'warning',
    Vendido: 'neutral',
    'Al día': 'success',
    'Sin pago': 'warning',
    'En riesgo': 'danger',
    Pagado: 'clay'
  };
  const stamp = document.createElement('span');
  stamp.className = 'stamp ' + (classByStatus[status] || 'neutral');
  stamp.textContent = status;
  return stamp;
}

function addLot(values) {
  const row = document.createElement('tr');
  row.append(
    createCell(values.lot.toUpperCase(), 'mono cell-primary'),
    createCell(values.project),
    createCell(Number(values.area).toLocaleString('en-US') + ' m²', 'mono cell-muted'),
    createAmountCell(values.basePrice)
  );
  const statusCell = document.createElement('td');
  statusCell.appendChild(createStatusStamp(values.status));
  row.appendChild(statusCell);
  document.getElementById('lotsTableBody').prepend(row);
}

function addContract(values) {
  const finalPrice = Number(values.finalPrice);
  const paid = Number(values.paid);
  const balance = Math.max(finalPrice - paid, 0);
  const row = document.createElement('tr');
  row.append(
    createCell(values.customer, 'cell-primary'),
    createCell(values.lot.toUpperCase(), 'mono'),
    createAmountCell(finalPrice),
    createAmountCell(paid, 'cell-muted'),
    createAmountCell(balance)
  );
  const statusCell = document.createElement('td');
  statusCell.appendChild(createStatusStamp(values.status));
  row.appendChild(statusCell);
  document.getElementById('contractsTableBody').prepend(row);
}

function getInitials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(function (part) {
    return part.charAt(0).toUpperCase();
  }).join('');
}

function addCustomer(values) {
  const card = document.createElement('div');
  card.className = 'cust-card';

  const top = document.createElement('div');
  top.className = 'cust-top';
  const avatar = document.createElement('div');
  avatar.className = 'cust-avatar';
  avatar.textContent = getInitials(values.customer);
  const identity = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'cust-name';
  name.textContent = values.customer;
  const role = document.createElement('div');
  role.className = 'cust-role';
  role.textContent = 'Cliente desde ' + values.since;
  identity.append(name, role);
  top.append(avatar, identity);

  const phoneRow = document.createElement('div');
  phoneRow.className = 'cust-row';
  phoneRow.append(createTextSpan('Teléfono'), createTextSpan(values.phone));
  const contractsRow = document.createElement('div');
  contractsRow.className = 'cust-row';
  contractsRow.append(createTextSpan('Contratos'), createTextSpan('Sin contratos'));
  card.append(top, phoneRow, contractsRow);
  document.getElementById('customersGrid').prepend(card);
}

function createTextSpan(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

function addReceipt(values) {
  const receiptsList = document.getElementById('receiptsList');
  const receiptNumbers = Array.from(receiptsList.querySelectorAll('.receipt-id')).map(function (element) {
    return Number(element.textContent.replace('#', ''));
  });
  const receiptNumber = String(Math.max(...receiptNumbers) + 1).padStart(4, '0');
  const row = document.createElement('div');
  row.className = 'receipt-row';

  const id = document.createElement('div');
  id.className = 'receipt-id';
  id.textContent = '#' + receiptNumber;
  const who = document.createElement('div');
  who.className = 'receipt-who';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = values.customer;
  const lot = document.createElement('div');
  lot.className = 'lot';
  lot.textContent = 'Lote ' + values.lot.toUpperCase() + ' · ' + values.paymentType.toLowerCase();
  who.append(name, lot);
  const amount = document.createElement('div');
  amount.className = 'receipt-amt';
  amount.textContent = formatCurrency(values.amount);
  const printButton = receiptsList.querySelector('.receipt-print').cloneNode(true);
  row.append(id, who, amount, printButton);
  receiptsList.prepend(row);

  const countTag = document.querySelector('#tab-receipts .card-head .tag');
  const totalReceipts = Number.parseInt(countTag.textContent, 10) + 1;
  countTag.textContent = totalReceipts + ' recibos';
}

entityForm.addEventListener('submit', function (event) {
  event.preventDefault();
  const firstInvalidField = entityForm.querySelector(':invalid');
  if (firstInvalidField) {
    showValidationErrors();
    firstInvalidField.focus();
    return;
  }

  entityForm.classList.remove('was-validated');
  const values = Object.fromEntries(new FormData(entityForm).entries());
  const addFunctions = {
    lots: addLot,
    contracts: addContract,
    customers: addCustomer,
    receipts: addReceipt
  };
  addFunctions[activeFormType](values);
  closeEntityModal();
});

// Currency toggle logic
document.querySelectorAll('.currency-toggle button').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.currency-toggle button').forEach(function (b) { b.classList.remove('on'); });
    btn.classList.add('on');
    var cur = btn.getAttribute('data-cur');
    document.querySelectorAll('.currency-prefix').forEach(function (prefix) {
      prefix.textContent = cur === 'usd' ? '$' : 'L.';
    });
    document.querySelectorAll('.amount').forEach(function (el) {
      el.textContent = cur === 'usd' ? el.getAttribute('data-usd') : el.getAttribute('data-lps');
    });
  });
});

// Sub-navigation chip logic
document.querySelectorAll('.chip').forEach(function (chip) {
  chip.addEventListener('click', function () {
    var group = chip.parentElement;
    group.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); });
    chip.classList.add('active');
  });
});
