/**
 * Temporary mail client for verification code polling.
 * Keeps a stable API surface for popup.js:
 * - generateEmail()
 * - waitForVerificationCode()
 */
class TempMailClient {
  constructor(config = {}) {
    this.provider = this.normalizeProvider(config.provider || 'tempmailplus');
    this.pollInterval = Number(config.pollInterval || 5000);
    this.maxAttempts = Number(config.maxAttempts || 60);
    this.currentEmail = null;
    this.currentToken = null;
  }

  normalizeProvider(provider) {
    const value = String(provider || '').trim().toLowerCase();
    if (['guerrilla-mail', 'guerrillamail', 'guerrilla'].includes(value)) return 'guerrilla';
    if (['1secmail', 'one-secmail'].includes(value)) return '1secmail';
    if (['tempmailplus', 'tempmail.plus', 'temp-mail-plus'].includes(value)) return 'tempmailplus';
    return value || 'tempmailplus';
  }

  inferProviderFromEmail(email) {
    const domain = String(email || '').toLowerCase().split('@')[1] || '';
    if (!domain) return null;
    if (domain.includes('guerrillamail')) return 'guerrilla';
    if (domain.includes('1secmail')) return '1secmail';
    if (domain.includes('tempmail.plus')) return 'tempmailplus';
    return null;
  }

  ensureProviderConsistency() {
    const inferred = this.inferProviderFromEmail(this.currentEmail);
    if (inferred && inferred !== this.provider) {
      console.warn(`[TempMail] Provider auto-correct: ${this.provider} -> ${inferred}`);
      this.provider = inferred;
    }
  }

  getMailId(mail) {
    if (!mail || typeof mail !== 'object') return null;
    return mail.id || mail.mail_id || mail.mailId || mail.mid || null;
  }

  async generateEmail() {
    console.log('[TempMail] Generating temporary mailbox...');

    switch (this.provider) {
      case 'tempmailplus':
        return await this.generateTempMailPlus();
      case 'guerrilla':
        return await this.generateGuerrillaMail();
      case '1secmail':
        return await this.generate1SecMail();
      default:
        throw new Error(`Unsupported provider: ${this.provider}`);
    }
  }

  async generateTempMailPlus() {
    try {
      console.log('[TempMail+] Using tempmail.plus');
      const response = await fetch('https://tempmail.plus/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        },
        body: JSON.stringify({
          count: 1,
          domain: 'tempmail.plus'
        })
      });

      if (!response.ok) {
        throw new Error(`TempMail+ API error: ${response.status}`);
      }

      const data = await response.json();
      if (!data || !data.email) {
        throw new Error('TempMail+ response missing email');
      }

      this.provider = 'tempmailplus';
      this.currentEmail = data.email;
      this.currentToken = data.email;

      console.log('[TempMail+] Mailbox created:', this.currentEmail);
      return { email: this.currentEmail, token: this.currentToken };
    } catch (error) {
      console.warn('[TempMail+] Failed, fallback to Guerrilla:', error.message);
      this.provider = 'guerrilla';
      return await this.generateGuerrillaMail();
    }
  }

  async generateGuerrillaMail() {
    const response = await fetch('https://api.guerrillamail.com/ajax.php?f=get_email_address');
    if (!response.ok) {
      throw new Error(`Guerrilla API error: ${response.status}`);
    }

    const data = await response.json();
    if (!data || !data.email_addr || !data.sid_token) {
      throw new Error('Guerrilla response missing required fields');
    }

    this.provider = 'guerrilla';
    this.currentEmail = data.email_addr;
    this.currentToken = data.sid_token;

    console.log('[Guerrilla] Mailbox created:', this.currentEmail);
    return { email: this.currentEmail, token: this.currentToken };
  }

  async generate1SecMail() {
    const domains = ['1secmail.com', '1secmail.net', '1secmail.org'];
    let lastError = null;

    for (const domain of domains) {
      try {
        const apiUrl = `https://${domain}/api/v1/?action=genRandomMailbox&count=1`;
        const response = await fetch(apiUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (!response.ok) continue;

        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0) continue;

        this.provider = '1secmail';
        this.currentEmail = data[0];
        this.currentToken = JSON.stringify({
          login: this.currentEmail.split('@')[0],
          domain: this.currentEmail.split('@')[1]
        });

        console.log('[1SecMail] Mailbox created:', this.currentEmail);
        return { email: this.currentEmail, token: this.currentToken };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Failed to generate 1SecMail mailbox');
  }

  async checkMails() {
    if (!this.currentEmail) {
      throw new Error('No mailbox yet, call generateEmail() first');
    }

    this.ensureProviderConsistency();

    try {
      switch (this.provider) {
        case 'tempmailplus':
          return await this.checkTempMailPlus();
        case 'guerrilla':
          return await this.checkGuerrillaMail();
        case '1secmail':
          return await this.check1SecMail();
        default:
          return [];
      }
    } catch (error) {
      console.error('[TempMail] checkMails failed:', error);
      return [];
    }
  }

  async checkTempMailPlus() {
    this.ensureProviderConsistency();
    if (this.provider !== 'tempmailplus') {
      return await this.checkMails();
    }

    const response = await fetch(`https://tempmail.plus/api/messages/${encodeURIComponent(this.currentEmail)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    if (!response.ok) {
      console.warn('[TempMail+] check messages failed:', response.status);
      return [];
    }

    const data = await response.json();
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.messages)) return data.messages;
    return [];
  }

  async checkGuerrillaMail() {
    const response = await fetch(
      `https://api.guerrillamail.com/ajax.php?f=check_email&seq=0&sid_token=${encodeURIComponent(this.currentToken || '')}`
    );

    if (!response.ok) {
      console.warn('[Guerrilla] check messages failed:', response.status);
      return [];
    }

    const data = await response.json();
    return Array.isArray(data.list) ? data.list : [];
  }

  async check1SecMail() {
    if (!this.currentToken) return [];

    try {
      const { login, domain } = JSON.parse(this.currentToken);
      const response = await fetch(
        `https://www.1secmail.com/api/v1/?action=getMessages&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );

      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    } catch (error) {
      console.error('[1SecMail] check messages failed:', error);
      return [];
    }
  }

  async getMailContent(mailId) {
    if (!mailId) return null;

    this.ensureProviderConsistency();

    switch (this.provider) {
      case 'tempmailplus':
        return await this.getTempMailPlusContent(mailId);
      case 'guerrilla':
        return await this.getGuerrillaMailContent(mailId);
      case '1secmail':
        return await this.get1SecMailContent(mailId);
      default:
        return null;
    }
  }

  async getTempMailPlusContent(mailId) {
    try {
      const response = await fetch(`https://tempmail.plus/api/message/${encodeURIComponent(mailId)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  async getGuerrillaMailContent(mailId) {
    if (!this.currentToken) return null;

    try {
      const response = await fetch(
        `https://api.guerrillamail.com/ajax.php?f=fetch_email&email_id=${encodeURIComponent(mailId)}&sid_token=${encodeURIComponent(this.currentToken)}`
      );
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  async get1SecMailContent(mailId) {
    if (!this.currentToken) return null;

    try {
      const { login, domain } = JSON.parse(this.currentToken);
      const response = await fetch(
        `https://www.1secmail.com/api/v1/?action=readMessage&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}&id=${encodeURIComponent(mailId)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  extractVerificationCode(text) {
    const content = String(text || '');
    const patterns = [
      /\b(\d{6})\b/,
      /verification\s*code[^\d]*(\d{6})/i,
      /code[^\d]*(\d{6})/i,
      /验证码[^\d]*(\d{6})/i
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  isLikelyTargetMail(subject, from, body) {
    const s = String(subject || '').toLowerCase();
    const f = String(from || '').toLowerCase();
    const b = String(body || '').toLowerCase();
    return (
      s.includes('windsurf') || s.includes('codeium') || s.includes('verification') ||
      f.includes('windsurf') || f.includes('codeium') ||
      b.includes('windsurf') || b.includes('codeium') || b.includes('verification code') || b.includes('验证码')
    );
  }

  async waitForVerificationCode() {
    console.log('[TempMail] Waiting for verification code...');

    for (let i = 0; i < this.maxAttempts; i++) {
      this.ensureProviderConsistency();
      console.log(`[TempMail] Poll ${i + 1}/${this.maxAttempts}, provider=${this.provider}, email=${this.currentEmail}`);

      const mails = await this.checkMails();
      console.log(`[TempMail] Messages found: ${mails.length}`);

      for (const mail of mails) {
        let mailContent = mail;
        const mailId = this.getMailId(mail);

        if (mailId) {
          const full = await this.getMailContent(mailId);
          if (full && typeof full === 'object') {
            mailContent = { ...mail, ...full };
          }
        }

        const subject = mailContent.subject || mailContent.mail_subject || '';
        const from = mailContent.from || mailContent.mail_from || '';
        const rawBody =
          mailContent.body || mailContent.text || mailContent.textBody || mailContent.htmlBody ||
          mailContent.mail_body || mailContent.mail_text || mailContent.snippet || '';

        const plainBody = String(rawBody).replace(/<[^>]+>/g, ' ');
        const combined = `${subject}\n${plainBody}`;
        const code = this.extractVerificationCode(combined);

        console.log('[TempMail] Check message:', {
          from,
          subject,
          hasCode: !!code,
          mailId
        });

        if (code) {
          const likely = this.isLikelyTargetMail(subject, from, plainBody);
          if (likely || mails.length === 1) {
            console.log(`[TempMail] Verification code found: ${code}`);
            return {
              success: true,
              code,
              mail
            };
          }
        }
      }

      if (i < this.maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, this.pollInterval));
      }
    }

    return {
      success: false,
      error: '未能获取验证码'
    };
  }
}
