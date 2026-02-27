console.log('[Windsurf Helper] Content script loaded (v2.0)');

function isWindsurfRegistrationPage(url) {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();

    const isSupportedHost =
      host === 'windsurf.com' ||
      host.endsWith('.windsurf.com') ||
      host === 'codeium.com' ||
      host.endsWith('.codeium.com');

    if (!isSupportedHost) return false;

    if (path.startsWith('/account/register')) {
      return true;
    }

    if (path.startsWith('/windsurf/signin')) {
      const workflow = (parsed.searchParams.get('workflow') || '').toLowerCase();
      const prompt = (parsed.searchParams.get('prompt') || '').toLowerCase();
      return workflow === 'onboarding' || prompt === 'login' || parsed.search.toLowerCase().includes('onboarding');
    }
  } catch (e) {
    return (
      url.includes('windsurf.com/account/register') ||
      (
        (url.includes('windsurf.com/windsurf/signin') || url.includes('codeium.com/windsurf/signin')) &&
        (url.includes('workflow=onboarding') || url.includes('prompt=login'))
      )
    );
  }

  return false;
}

const CONFIG = {
  MAX_WAIT_TIME: 10000,
  ELEMENT_CHECK_INTERVAL: 100,
  MAX_RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 2000,
  CLOUDFLARE_TIMEOUT: 180000
};

let activeIntervals = [];
let activeTimeouts = [];
let cloudflareWatchActive = false;
let cloudflareObserver = null;

function waitForElement(selector, timeout = CONFIG.MAX_WAIT_TIME) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const checkElement = () => {
      const element = document.querySelector(selector);
      
      if (element) {
        console.log(`[Content] 找到元素: ${selector}`);
        resolve(element);
        return;
      }
      
      if (Date.now() - startTime > timeout) {
        console.error(`[Content] 等待元素超时: ${selector}`);
        reject(new Error(`Element not found: ${selector}`));
        return;
      }
      
      setTimeout(checkElement, CONFIG.ELEMENT_CHECK_INTERVAL);
    };
    
    checkElement();
  });
}

function waitForAnyElement(selectors, timeout = CONFIG.MAX_WAIT_TIME) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const checkElements = () => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) {
          console.log(`[Content] 找到元素: ${selector}`);
          resolve({ element, selector });
          return;
        }
      }
      
      if (Date.now() - startTime > timeout) {
        console.error(`[Content] 等待元素超时: ${selectors.join(', ')}`);
        reject(new Error(`Elements not found: ${selectors.join(', ')}`));
        return;
      }
      
      setTimeout(checkElements, CONFIG.ELEMENT_CHECK_INTERVAL);
    };
    
    checkElements();
  });
}

function safelyFillInput(input, value) {
  if (!input) {
    console.error('[Content] 输入框不存在');
    return false;
  }
  if (value === undefined || value === null) {
    console.error('[Content] 填充值无效:', value);
    return false;
  }
  
  try {
    const stringValue = String(value);
    console.log(`[Content] 准备填充: ${stringValue} 到元素:`, input);
    
    input.value = stringValue;
    
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    ).set;
    nativeInputValueSetter.call(input, stringValue);
    
    input.focus();
    
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true, composed: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    
    if (input.value !== stringValue) {
      console.warn(`[Content] 填充验证失败，期望: ${stringValue}, 实际: ${input.value}`);
      input.value = stringValue;
      nativeInputValueSetter.call(input, stringValue);
    }
    
    console.log(`[Content] ✅ 已填充: ${stringValue}, 当前值: ${input.value}`);
    return input.value === stringValue;
  } catch (error) {
    console.error('[Content] 填充失败:', error);
    return false;
  }
}

function generateRealName() {
  const firstNames = ['James', 'John', 'Robert', 'Michael', 'William', 'David', 'Richard', 'Joseph', 'Thomas', 'Charles',
                      'Mary', 'Patricia', 'Jennifer', 'Linda', 'Elizabeth', 'Barbara', 'Susan', 'Jessica', 'Sarah', 'Karen'];
  const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
                     'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin', 'Lee', 'White', 'Harris'];
  
  const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
  const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
  
  return { firstName, lastName };
}

function detectCurrentStep() {
  const url = window.location.href;
  console.log('[Content] 检测页面:', url);
  
  if (isWindsurfRegistrationPage(url)) {
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    const textInputs = document.querySelectorAll('input[type="text"], input[type="email"]');
    
    if (passwordInputs.length >= 2) {
      return 'step2';
    } else if (textInputs.length >= 3) {
      return 'step1';
    } else {
      return detectOAuthPageStep();
    }
  }
  
  return 'unknown';
}

function detectOAuthPageStep() {
  const url = window.location.href;

  if ((url.includes('windsurf.com/windsurf/signin') || url.includes('codeium.com/windsurf/signin')) &&
      (url.includes('workflow=onboarding') || url.includes('prompt=login'))) {
    
    const emailInputs = document.querySelectorAll('input[type="email"]');
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    const textInputs = document.querySelectorAll('input[type="text"]');
    
    if (emailInputs.length > 0 && passwordInputs.length > 0) {
      return 'oauth_full';
    }
    
    if (emailInputs.length > 0 && passwordInputs.length === 0) {
      return 'oauth_email';
    }
    
    if (textInputs.length > 0 && emailInputs.length === 0 && passwordInputs.length === 0) {
      return 'oauth_name';
    }
  }
  
  return 'unknown';
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Content] 收到消息:', message);
  
  if (message.action === 'fillForm') {
    handleFillForm(message.data).then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  } else if (message.action === 'fillVerificationCode') {
    fillVerificationCode(message.code);
    sendResponse({ success: true });
  } else if (message.action === 'detectStep') {
    const step = detectCurrentStep();
    sendResponse({ success: true, step });
  }
  
  return true;
});

async function handleFillForm(data) {
  console.log('[Content] 开始填充表单:', data);
  
  await chrome.storage.local.set({ currentAccountData: data });
  
  await new Promise(resolve => setTimeout(resolve, 300));
  
  const step = detectCurrentStep();
  console.log('[Content] 检测到步骤:', step);
  
  try {
    if (step === 'step1') {
      await fillStep1WithRetry(data);
      return { success: true, step: 'step1' };
    } else if (step === 'step2') {
      await fillStep2WithRetry(data);
      return { success: true, step: 'step2' };
    } else if (step === 'oauth_full') {
      await fillOAuthFullWithRetry(data);
      return { success: true, step: 'oauth_full' };
    } else if (step === 'oauth_email') {
      await fillOAuthEmailWithRetry(data);
      return { success: true, step: 'oauth_email' };
    } else if (step === 'oauth_name') {
      await fillOAuthNameWithRetry(data);
      return { success: true, step: 'oauth_name' };
    } else {
      throw new Error('无法识别当前步骤，请确认页面URL');
    }
  } catch (error) {
    console.error('[Content] 填充失败:', error);
    return { success: false, error: error.message };
  }
}

async function fillStep1WithRetry(data, attemptCount = 0) {
  console.log(`[Content] 填充步骤1 (尝试 ${attemptCount + 1}/${CONFIG.MAX_RETRY_ATTEMPTS})`);
  
  try {
    await fillStep1(data);
  } catch (error) {
    if (attemptCount < CONFIG.MAX_RETRY_ATTEMPTS - 1) {
      console.warn(`[Content] 步骤1失败，${CONFIG.RETRY_DELAY}ms后重试...`);
      await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
      return fillStep1WithRetry(data, attemptCount + 1);
    } else {
      throw error;
    }
  }
}

async function fillStep1(data) {
  console.log('[Content] 执行步骤1填充');
  
  await new Promise(resolve => setTimeout(resolve, 500));
  
  const inputs = document.querySelectorAll('input[type="text"], input[type="email"]');
  if (inputs.length < 3) {
    throw new Error('输入框数量不足');
  }
  
  const { firstName, lastName } = generateRealName();
  
  if (!safelyFillInput(inputs[0], firstName)) {
    throw new Error('填充名失败');
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  
  if (!safelyFillInput(inputs[1], lastName)) {
    throw new Error('填充姓失败');
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  
  const emailInput = document.querySelector('input[type="email"]') || inputs[2];
  if (!safelyFillInput(emailInput, data.email)) {
    throw new Error('填充邮箱失败');
  }
  await new Promise(resolve => setTimeout(resolve, 500));
  
  await checkTermsCheckbox();
  
  await clickContinueButton();
  
  console.log('[Content] 等待步骤2页面加载...');
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const result = await chrome.storage.local.get(['currentAccountData']);
  if (result.currentAccountData) {
    await fillStep2WithRetry(result.currentAccountData);
  }
}

async function checkTermsCheckbox() {
  try {
    const checkbox = await waitForElement('input[type="checkbox"]', 5000);
    if (checkbox && !checkbox.checked) {
      checkbox.click();
      console.log('[Content] 已勾选同意条款');
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  } catch (error) {
    console.warn('[Content] 未找到同意条款复选框');
  }
}

async function clickContinueButton() {
  try {
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const buttons = Array.from(document.querySelectorAll('button:not([disabled])'));
    const continueBtn = buttons.find(btn => 
      btn.textContent.includes('继续') || 
      btn.textContent.includes('Continue')
    );
    
    if (continueBtn) {
      continueBtn.click();
      console.log('[Content] 已点击"继续"按钮');
    } else {
      throw new Error('未找到"继续"按钮');
    }
  } catch (error) {
    console.error('[Content] 点击继续按钮失败:', error);
    throw error;
  }
}

async function fillStep2WithRetry(data, attemptCount = 0) {
  console.log(`[Content] 填充步骤2 (尝试 ${attemptCount + 1}/${CONFIG.MAX_RETRY_ATTEMPTS})`);
  
  try {
    await fillStep2(data);
  } catch (error) {
    if (attemptCount < CONFIG.MAX_RETRY_ATTEMPTS - 1) {
      console.warn(`[Content] 步骤2失败，${CONFIG.RETRY_DELAY}ms后重试...`);
      await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
      return fillStep2WithRetry(data, attemptCount + 1);
    } else {
      throw error;
    }
  }
}

async function fillStep2(data) {
  console.log('[Content] 执行步骤2填充');
  
  await new Promise(resolve => setTimeout(resolve, 800));
  
  const passwordInputs = document.querySelectorAll('input[type="password"]');
  if (passwordInputs.length < 2) {
    throw new Error('密码输入框数量不足');
  }
  
  if (!safelyFillInput(passwordInputs[0], data.password)) {
    throw new Error('填充密码失败');
  }
  await new Promise(resolve => setTimeout(resolve, 400));
  
  if (!safelyFillInput(passwordInputs[1], data.password)) {
    throw new Error('填充密码确认失败');
  }
  await new Promise(resolve => setTimeout(resolve, 500));
  
  console.log('[Content] 步骤2完成，等待Cloudflare验证...');
  
  waitForCloudflareAndSubmit();
}

function waitForCloudflareAndSubmit() {
  if (cloudflareWatchActive) {
    console.log('[Content] Cloudflare监听已在运行，跳过重复启动');
    return;
  }
  cloudflareWatchActive = true;
  console.log('[Content] 开始监听Cloudflare验证状态...');
  
  const checkInterval = setInterval(() => {
    const buttons = Array.from(document.querySelectorAll('button:not([disabled])'));
    const continueBtn = buttons.find(btn => 
      btn.textContent.includes('继续') || 
      btn.textContent.includes('Continue')
    );
    
    if (continueBtn) {
      clearInterval(checkInterval);
      removeFromActiveIntervals(checkInterval);
      cloudflareWatchActive = false;
      console.log('[Content] Cloudflare验证完成');
      
      const submitTimeout = setTimeout(() => {
        continueBtn.click();
        console.log('[Content] 已自动提交注册表单');
        
        chrome.runtime.sendMessage({
          action: 'registrationSubmitted',
          success: true
        });
      }, 1000);
      
      activeTimeouts.push(submitTimeout);
    }
  }, 1000);
  
  activeIntervals.push(checkInterval);
  
  const timeoutHandler = setTimeout(() => {
    console.log('[Content] Cloudflare验证耗时较长，继续监听中...');
    
    chrome.runtime.sendMessage({
      action: 'cloudflareWaiting',
      message: '请手动完成Cloudflare验证'
    });
  }, CONFIG.CLOUDFLARE_TIMEOUT);
  
  activeTimeouts.push(timeoutHandler);
}

function removeFromActiveIntervals(interval) {
  const index = activeIntervals.indexOf(interval);
  if (index > -1) {
    activeIntervals.splice(index, 1);
  }
}

function cleanupTimers() {
  activeIntervals.forEach(interval => clearInterval(interval));
  activeTimeouts.forEach(timeout => clearTimeout(timeout));
  activeIntervals = [];
  activeTimeouts = [];
  cloudflareWatchActive = false;
  console.log('[Content] 已清理所有定时器');
}

function fillVerificationCode(code) {
  console.log('[Content] 填充验证码:', code);
  
  const codeInput = document.querySelector('input[name="code"], input[name="verificationCode"]');
  
  if (codeInput) {
    safelyFillInput(codeInput, code);
    
    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) {
      setTimeout(() => {
        submitBtn.click();
        console.log('[Content] 已自动提交验证码');
      }, 500);
    }
  } else {
    console.warn('[Content] 未找到验证码输入框');
  }
}
async function fillOAuthFull(data) {
  console.log('[Content] 执行OAuth完整页面填充');
  
  await new Promise(resolve => setTimeout(resolve, 500));
  
  const { firstName, lastName } = generateRealName();
  
  const textInputs = document.querySelectorAll('input[type="text"]');
  if (textInputs.length >= 2) {
    if (!safelyFillInput(textInputs[0], firstName)) {
      throw new Error('填充名字失败');
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    
    if (!safelyFillInput(textInputs[1], lastName)) {
      throw new Error('填充姓氏失败');
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  const emailInput = document.querySelector('input[type="email"]');
  if (emailInput) {
    if (!safelyFillInput(emailInput, data.email)) {
      throw new Error('填充邮箱失败');
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  const passwordInputs = document.querySelectorAll('input[type="password"]');
  if (passwordInputs.length >= 1) {
    if (!safelyFillInput(passwordInputs[0], data.password)) {
      throw new Error('填充密码失败');
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  await checkTermsCheckbox();
  await clickOAuthSubmitButton();
  waitForCloudflareAndSubmit();
  
  console.log('[Content] OAuth完整页面填充完成');
}

async function fillOAuthEmailWithRetry(data, attemptCount = 0) {
  console.log(`[Content] 填充OAuth邮箱步骤 (尝试 ${attemptCount + 1}/${CONFIG.MAX_RETRY_ATTEMPTS})`);
  
  try {
    await fillOAuthEmail(data);
  } catch (error) {
    if (attemptCount < CONFIG.MAX_RETRY_ATTEMPTS - 1) {
      console.warn(`[Content] OAuth邮箱步骤失败，${CONFIG.RETRY_DELAY}ms后重试...`);
      await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
      return fillOAuthEmailWithRetry(data, attemptCount + 1);
    } else {
      throw error;
    }
  }
}

async function fillOAuthEmail(data) {
  console.log('[Content] 执行OAuth邮箱步骤填充');
  
  await new Promise(resolve => setTimeout(resolve, 500));
  
  const emailInput = document.querySelector('input[type="email"]');
  if (emailInput) {
    if (!safelyFillInput(emailInput, data.email)) {
      throw new Error('填充邮箱失败');
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  await clickOAuthContinueButton();
  
  console.log('[Content] OAuth邮箱步骤填充完成');
}

async function fillOAuthNameWithRetry(data, attemptCount = 0) {
  console.log(`[Content] 填充OAuth姓名步骤 (尝试 ${attemptCount + 1}/${CONFIG.MAX_RETRY_ATTEMPTS})`);
  
  try {
    await fillOAuthName(data);
  } catch (error) {
    if (attemptCount < CONFIG.MAX_RETRY_ATTEMPTS - 1) {
      console.warn(`[Content] OAuth姓名步骤失败，${CONFIG.RETRY_DELAY}ms后重试...`);
      await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
      return fillOAuthNameWithRetry(data, attemptCount + 1);
    } else {
      throw error;
    }
  }
}

async function fillOAuthName(data) {
  console.log('[Content] 执行OAuth姓名步骤填充');
  
  await new Promise(resolve => setTimeout(resolve, 500));
  
  const { firstName, lastName } = generateRealName();
  
  const textInputs = document.querySelectorAll('input[type="text"]');
  if (textInputs.length >= 2) {
    if (!safelyFillInput(textInputs[0], firstName)) {
      throw new Error('填充名字失败');
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    
    if (!safelyFillInput(textInputs[1], lastName)) {
      throw new Error('填充姓氏失败');
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  await clickOAuthContinueButton();
  
  console.log('[Content] OAuth姓名步骤填充完成');
}

async function clickOAuthContinueButton() {
  try {
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const buttons = Array.from(document.querySelectorAll('button:not([disabled])'));
    const continueBtn = buttons.find(btn => 
      btn.textContent.includes('继续') || 
      btn.textContent.includes('Continue') ||
      btn.textContent.includes('下一步') ||
      btn.textContent.includes('Next')
    );
    
    if (continueBtn) {
      continueBtn.click();
      console.log('[Content] 已点击OAuth继续按钮');
    } else {
      throw new Error('未找到OAuth继续按钮');
    }
  } catch (error) {
    console.error('[Content] 点击OAuth继续按钮失败:', error);
    throw error;
  }
}

async function clickOAuthSubmitButton() {
  try {
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const buttons = Array.from(document.querySelectorAll('button:not([disabled])'));
    const submitBtn = buttons.find(btn => 
      btn.textContent.includes('注册') || 
      btn.textContent.includes('Register') ||
      btn.textContent.includes('创建') ||
      btn.textContent.includes('Create') ||
      btn.textContent.includes('提交') ||
      btn.textContent.includes('Submit')
    );
    
    if (submitBtn) {
      submitBtn.click();
      console.log('[Content] 已点击OAuth提交按钮');
    } else {
      await clickOAuthContinueButton();
    }
  } catch (error) {
    console.error('[Content] 点击OAuth提交按钮失败:', error);
    throw error;
  }
}

function normalizeActionText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isClickableActionElement(el) {
  if (!el) return false;
  if (el.disabled) return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;

  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') {
    return false;
  }
  return el.getClientRects().length > 0;
}

function findCloudflareActionButton() {
  const selectors = [
    'button',
    '[role=\"button\"]',
    'input[type=\"submit\"]',
    'input[type=\"button\"]',
    'a[role=\"button\"]'
  ];
  const positive = ['continue', 'next', 'submit', 'register', 'create', '继续', '下一步', '提交', '注册', '创建'];
  const negative = ['back', 'cancel', 'return', '返回', '取消', '上一步'];

  const elements = Array.from(document.querySelectorAll(selectors.join(',')))
    .filter(isClickableActionElement);

  for (const el of elements) {
    const text = normalizeActionText(
      el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title')
    );
    if (!text) continue;
    if (positive.some(k => text.includes(k)) && !negative.some(k => text.includes(k))) {
      return el;
    }
  }

  return null;
}

function findContinueLikeButton() {
  const selectors = [
    'button',
    '[role="button"]',
    'input[type="submit"]',
    'input[type="button"]'
  ];

  const keywords = ['continue', 'next', 'submit', '继续', '下一步', '提交'];
  const candidates = Array.from(document.querySelectorAll(selectors.join(',')))
    .filter(isClickableActionElement);

  for (const el of candidates) {
    const text = normalizeActionText(
      el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title')
    );
    if (!text) continue;
    if (keywords.some(k => text.includes(k))) {
      return el;
    }
  }
  return null;
}

function hasHumanCheckPrompt() {
  const text = normalizeActionText(document.body?.innerText || '');
  return (
    text.includes('请确认你是人类') ||
    text.includes('verify you are human') ||
    text.includes('i am human')
  );
}

function tryAutoContinueAfterCloudflare(source = 'unknown') {
  const actionButton = findCloudflareActionButton();
  if (!actionButton) return false;

  // Try richer mouse sequence before native click.
  actionButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
  actionButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
  actionButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  actionButton.click();

  console.log(`[Content] Cloudflare auto-continue click (${source})`);
  return true;
}

function removeFromActiveTimeouts(timeout) {
  const index = activeTimeouts.indexOf(timeout);
  if (index > -1) {
    activeTimeouts.splice(index, 1);
  }
}

// Override with a more robust watcher: interval + MutationObserver + verified progress check.
function waitForCloudflareAndSubmit() {
  if (cloudflareWatchActive) {
    console.log('[Content] Cloudflare watcher already active, skip duplicate start');
    return;
  }

  cloudflareWatchActive = true;
  let submittedNotified = false;
  let timeoutHandler = null;
  let clickAttempts = 0;
  let lastClickTs = 0;

  const CLICK_COOLDOWN_MS = 1200;
  const MAX_CLICK_ATTEMPTS = 12;

  const notifySubmitted = () => {
    if (submittedNotified) return;
    submittedNotified = true;
    chrome.runtime.sendMessage({
      action: 'registrationSubmitted',
      success: true
    });
  };

  const stopWatcher = (checkInterval) => {
    clearInterval(checkInterval);
    removeFromActiveIntervals(checkInterval);
    if (cloudflareObserver) {
      cloudflareObserver.disconnect();
      cloudflareObserver = null;
    }
    if (timeoutHandler) {
      clearTimeout(timeoutHandler);
      removeFromActiveTimeouts(timeoutHandler);
      timeoutHandler = null;
    }
    cloudflareWatchActive = false;
  };

  const isGateCleared = () => {
    // If the dedicated human-check prompt still exists, treat as not cleared.
    if (hasHumanCheckPrompt() && findContinueLikeButton()) {
      return false;
    }

    const markerNodes = Array.from(document.querySelectorAll(
      '.cf-turnstile, iframe[src*="challenges.cloudflare.com"], [id*="cf-challenge"], [class*="cf-"]'
    ));

    const hasVisibleCloudflareMarker = markerNodes.some((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return el.getClientRects().length > 0;
    });

    const hasVisibleAction = !!findCloudflareActionButton();

    // Clear only when known challenge markers and continue-like actions are gone.
    return !hasVisibleCloudflareMarker && !hasVisibleAction && !findContinueLikeButton();
  };

  const tryClickWithVerification = (source, checkInterval) => {
    const now = Date.now();
    if (now - lastClickTs < CLICK_COOLDOWN_MS) return;
    if (clickAttempts >= MAX_CLICK_ATTEMPTS) return;

    if (!tryAutoContinueAfterCloudflare(source)) return;

    clickAttempts += 1;
    lastClickTs = now;
    console.log(`[Content] auto-continue attempt ${clickAttempts}/${MAX_CLICK_ATTEMPTS}`);

    const verifyTimer = setTimeout(() => {
      if (isGateCleared()) {
        notifySubmitted();
        stopWatcher(checkInterval);
      } else if (clickAttempts >= MAX_CLICK_ATTEMPTS) {
        chrome.runtime.sendMessage({
          action: 'cloudflareWaiting',
          message: '自动点击继续未生效，请手动点击“继续”一次'
        });
      }
    }, 1000);

    activeTimeouts.push(verifyTimer);
  };

  const checkInterval = setInterval(() => {
    tryClickWithVerification('interval', checkInterval);
  }, 400);
  activeIntervals.push(checkInterval);

  cloudflareObserver = new MutationObserver(() => {
    tryClickWithVerification('observer', checkInterval);
  });
  cloudflareObserver.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'disabled', 'aria-disabled']
  });

  timeoutHandler = setTimeout(() => {
    console.log('[Content] Cloudflare taking longer than expected, keep watching...');
    chrome.runtime.sendMessage({
      action: 'cloudflareWaiting',
      message: '请手动完成Cloudflare验证'
    });
  }, CONFIG.CLOUDFLARE_TIMEOUT);
  activeTimeouts.push(timeoutHandler);

  tryClickWithVerification('initial', checkInterval);
}

// Override cleanup to also close MutationObserver.
function cleanupTimers() {
  activeIntervals.forEach(interval => clearInterval(interval));
  activeTimeouts.forEach(timeout => clearTimeout(timeout));
  activeIntervals = [];
  activeTimeouts = [];
  if (cloudflareObserver) {
    cloudflareObserver.disconnect();
    cloudflareObserver = null;
  }
  cloudflareWatchActive = false;
  console.log('[Content] 已清理所有定时器');
}

window.addEventListener('load', () => {
  const step = detectCurrentStep();
  chrome.runtime.sendMessage({
    action: 'pageReady',
    url: window.location.href,
    step: step
  });
  
  console.log('[Content] 页面已加载，当前步骤:', step);
});

window.addEventListener('beforeunload', () => {
  cleanupTimers();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    console.log('[Content] 页面隐藏，清理定时器');
    cleanupTimers();
  }
});

// --- Codex hotfix: re-arm auto continue on dedicated human-check page ---
function __whIsHumanGatePageV2() {
  if (hasHumanCheckPrompt() && findContinueLikeButton()) {
    return true;
  }

  const markerNodes = Array.from(document.querySelectorAll(
    '.cf-turnstile, iframe[src*="challenges.cloudflare.com"], [id*="cf-challenge"], [class*="cf-"]'
  ));

  const hasVisibleCloudflareMarker = markerNodes.some((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return el.getClientRects().length > 0;
  });

  const hasAction = (typeof findCloudflareActionButton === 'function')
    ? !!findCloudflareActionButton()
    : !!document.querySelector('button, [role="button"], input[type="submit"], input[type="button"]');

  // Structural detection only; avoid locale/encoding dependency.
  return hasAction && hasVisibleCloudflareMarker;
}

function __whArmCloudflareWatcherV2(source) {
  try {
    if (!isWindsurfRegistrationPage(window.location.href)) return;
    if (!__whIsHumanGatePageV2()) return;
    if (typeof waitForCloudflareAndSubmit === 'function') {
      console.log('[Content] Arm Cloudflare auto-continue watcher from', source);
      waitForCloudflareAndSubmit();
    }
  } catch (e) {
    console.warn('[Content] Arm watcher failed:', e && e.message ? e.message : e);
  }
}

window.addEventListener('load', () => {
  setTimeout(() => __whArmCloudflareWatcherV2('load'), 250);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    setTimeout(() => __whArmCloudflareWatcherV2('visible'), 100);
  }
});

