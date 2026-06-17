import { describe, it, expect } from 'vitest';
import { parseDmarcXml } from '../src/services/dmarc-processor.js';

const XML = `<?xml version="1.0"?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <report_id>8083389405733463542</report_id>
    <date_range><begin>1781395200</begin><end>1781481599</end></date_range>
  </report_metadata>
  <policy_published><domain>keresai.com</domain><p>none</p></policy_published>
  <record>
    <row><source_ip>63.250.43.88</source_ip><count>3</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>
    <auth_results><dkim><domain>keresai.com</domain><result>pass</result></dkim><spf><domain>keresai.com</domain><result>pass</result></spf></auth_results>
  </record>
  <record>
    <row><source_ip>209.85.220.41</source_ip><count>4</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated></row>
    <auth_results><dkim><result>pass</result></dkim><spf><result>pass</result></spf></auth_results>
  </record>
</feedback>`;

describe('parseDmarcXml', () => {
  it('extracts metadata + policy', () => {
    const s = parseDmarcXml(XML);
    expect(s.reportId).toBe('8083389405733463542');
    expect(s.orgName).toBe('google.com');
    expect(s.domain).toBe('keresai.com');
    expect(s.policy).toBe('none');
  });

  it('counts DMARC pass when EITHER mechanism aligns', () => {
    const s = parseDmarcXml(XML);
    expect(s.totalMessages).toBe(7);     // 3 + 4
    expect(s.dmarcPass).toBe(7);         // both records pass (2nd via DKIM)
    expect(s.dmarcFail).toBe(0);
    expect(s.rows).toHaveLength(2);
    expect(s.rows[1]!.spfAligned).toBe('fail');
    expect(s.rows[1]!.dkimAligned).toBe('pass');
  });
});
