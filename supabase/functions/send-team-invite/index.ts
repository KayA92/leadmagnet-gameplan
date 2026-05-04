import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://autoevent.io";

async function checkUserExists(email: string): Promise<boolean> {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data } = await supabase
    .from("users")
    .select("id")
    .eq("email", email.toLowerCase())
    .maybeSingle();
  return data !== null;
}

function buildNewUserEmail(
  inviterName: string,
  inviterCompany: string,
  ctaUrl: string,
): string {
  const from = inviterName || inviterCompany || "A colleague";
  const companyLine = inviterCompany ? ` from ${inviterCompany}` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${from} invited you to Accountex 2026</title>
<style>
  @media only screen and (max-width:600px){
    .container{width:100%!important;max-width:100%!important}
    .px-32{padding-left:22px!important;padding-right:22px!important}
    .h1{font-size:28px!important;line-height:1.18!important}
    .cta-btn{display:block!important;width:100%!important;box-sizing:border-box!important}
  }
  a{color:#ff5e84}
</style>
</head>
<body style="margin:0;padding:0;background:#0a0a12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#f5f2ec;-webkit-font-smoothing:antialiased;">

<div style="display:none;font-size:1px;color:#0a0a12;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">
  Build your free plan and you'll automatically join ${from}'s workspace.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a12;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#15151f;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.04);">

        <!-- HERO -->
        <tr>
          <td class="px-32" style="background:#0a0a12;background-image:linear-gradient(135deg,#0a0a12 0%,#15151f 100%);padding:36px 40px 28px;color:#ffffff;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:'JetBrains Mono',Menlo,monospace;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#22e6a8;padding-bottom:14px;">
                  Team invite · Accountex 2026
                </td>
              </tr>
              <tr>
                <td class="h1" style="font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:1.15;color:#ffffff;font-weight:400;letter-spacing:-0.01em;padding-bottom:8px;">
                  You've been invited<br>
                  <em style="font-style:italic;color:#ff5e84;">to plan Accountex 2026.</em>
                </td>
              </tr>
              <tr>
                <td style="font-size:15px;line-height:1.55;color:rgba(255,255,255,0.78);padding-top:6px;">
                  <strong style="color:#ffffff;">${from}${companyLine}</strong> is using AutoEvent to plan Accountex 2026 — the free AI session planner for UK accountants — and wants you in their workspace.
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td class="px-32" style="padding:32px 40px 12px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="padding-bottom:14px;">
                  <!--[if mso]>
                  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${ctaUrl}" style="height:54px;v-text-anchor:middle;width:320px;" arcsize="22%" stroke="f" fillcolor="#ff5e84">
                    <w:anchorlock/>
                    <center style="color:#ffffff;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;">Create your free plan</center>
                  </v:roundrect>
                  <![endif]-->
                  <!--[if !mso]><!-- -->
                  <a href="${ctaUrl}" class="cta-btn" style="display:inline-block;background:#ff5e84;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:17px 36px;border-radius:12px;box-shadow:0 4px 14px rgba(255,94,132,0.3);letter-spacing:0.01em;">
                    Create your free plan →
                  </a>
                  <!--<![endif]-->
                </td>
              </tr>
              <tr>
                <td align="center" style="font-family:'JetBrains Mono',Menlo,monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#8c8a9e;">
                  Takes about 60 seconds · No account needed
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- What happens -->
        <tr>
          <td class="px-32" style="padding:24px 40px 8px;">
            <div style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:500;letter-spacing:-0.01em;color:#f5f2ec;padding-bottom:12px;">
              What happens next.
            </div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding:10px 14px;background:#1c1c28;border:1px solid rgba(255,255,255,0.08);border-radius:10px;">
                  <div style="font-family:'JetBrains Mono',Menlo,monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#ff5e84;padding-bottom:4px;">Step 1 — build your plan</div>
                  <div style="font-size:14px;line-height:1.5;color:#f5f2ec;">Answer 4 quick questions and the AI picks the best sessions and booths for you from 250+ options at the show.</div>
                </td>
              </tr>
              <tr><td style="height:8px;line-height:8px;font-size:8px;">&nbsp;</td></tr>
              <tr>
                <td style="padding:10px 14px;background:#1c1c28;border:1px solid rgba(255,255,255,0.08);border-radius:10px;">
                  <div style="font-family:'JetBrains Mono',Menlo,monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#22e6a8;padding-bottom:4px;">Step 2 — join ${from}'s workspace</div>
                  <div style="font-size:14px;line-height:1.5;color:#f5f2ec;">Once you save your plan, you're added to ${from}'s workspace automatically. See where you overlap and split coverage across sessions.</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer note -->
        <tr>
          <td class="px-32" style="padding:20px 40px 32px;">
            <div style="font-size:13px;line-height:1.55;color:#8c8a9e;">
              AutoEvent is a free AI planner for Accountex 2026. No subscription, no password — just a magic link when you save. Built by Workiro.
            </div>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="background:#1c1c28;padding:24px 40px;border-top:1px solid rgba(255,255,255,0.08);">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-size:12px;line-height:1.55;color:#8c8a9e;">
                  Sent by <a href="https://workiro.com" style="color:#8c8a9e;text-decoration:underline;">Workiro</a> · AutoEvent is a free planning tool for professional events.<br>
                  <a href="https://www.workiro.com/terms-and-policies/autoevent" style="color:#8c8a9e;text-decoration:underline;">Privacy &amp; terms</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>

</body>
</html>`;
}

function buildExistingUserEmail(
  inviterName: string,
  inviterCompany: string,
  ctaUrl: string,
): string {
  const from = inviterName || inviterCompany || "A colleague";
  const companyLine = inviterCompany ? ` from ${inviterCompany}` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${from} wants you in their Accountex team</title>
<style>
  @media only screen and (max-width:600px){
    .container{width:100%!important;max-width:100%!important}
    .px-32{padding-left:22px!important;padding-right:22px!important}
    .h1{font-size:28px!important;line-height:1.18!important}
    .cta-btn{display:block!important;width:100%!important;box-sizing:border-box!important}
  }
  a{color:#ff5e84}
</style>
</head>
<body style="margin:0;padding:0;background:#0a0a12;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#f5f2ec;-webkit-font-smoothing:antialiased;">

<div style="display:none;font-size:1px;color:#0a0a12;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">
  Already using AutoEvent? Just refresh the app — you'll see the invite there.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a12;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#15151f;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.04);">

        <!-- HERO -->
        <tr>
          <td class="px-32" style="background:#0a0a12;background-image:linear-gradient(135deg,#0a0a12 0%,#15151f 100%);padding:36px 40px 28px;color:#ffffff;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:'JetBrains Mono',Menlo,monospace;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#22e6a8;padding-bottom:14px;">
                  Team invite · Accountex 2026
                </td>
              </tr>
              <tr>
                <td class="h1" style="font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:1.15;color:#ffffff;font-weight:400;letter-spacing:-0.01em;padding-bottom:8px;">
                  ${from} wants you<br>
                  <em style="font-style:italic;color:#ff5e84;">in their workspace.</em>
                </td>
              </tr>
              <tr>
                <td style="font-size:15px;line-height:1.55;color:rgba(255,255,255,0.78);padding-top:6px;">
                  <strong style="color:#ffffff;">${from}${companyLine}</strong> has invited you to join their Accountex 2026 workspace on AutoEvent. You'll be able to see each other's session picks, spot overlaps, and coordinate coverage.
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td class="px-32" style="padding:32px 40px 12px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="padding-bottom:14px;">
                  <!--[if mso]>
                  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${ctaUrl}" style="height:54px;v-text-anchor:middle;width:320px;" arcsize="22%" stroke="f" fillcolor="#ff5e84">
                    <w:anchorlock/>
                    <center style="color:#ffffff;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;">Join ${from}'s workspace</center>
                  </v:roundrect>
                  <![endif]-->
                  <!--[if !mso]><!-- -->
                  <a href="${ctaUrl}" class="cta-btn" style="display:inline-block;background:#ff5e84;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:17px 36px;border-radius:12px;box-shadow:0 4px 14px rgba(255,94,132,0.3);letter-spacing:0.01em;">
                    Join ${from}'s workspace →
                  </a>
                  <!--<![endif]-->
                </td>
              </tr>
              <tr>
                <td align="center" style="font-family:'JetBrains Mono',Menlo,monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#8c8a9e;">
                  Already in the app? Just refresh — you'll see it there
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- What you unlock -->
        <tr>
          <td class="px-32" style="padding:24px 40px 8px;">
            <div style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:500;letter-spacing:-0.01em;color:#f5f2ec;padding-bottom:12px;">
              What joining unlocks.
            </div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding:10px 14px;background:#1c1c28;border:1px solid rgba(255,255,255,0.08);border-radius:10px;">
                  <div style="font-family:'JetBrains Mono',Menlo,monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#ff5e84;padding-bottom:4px;">Shared session map</div>
                  <div style="font-size:14px;line-height:1.5;color:#f5f2ec;">${from}'s session picks appear alongside yours. Tap any session to see who's going and avoid doubling up.</div>
                </td>
              </tr>
              <tr><td style="height:8px;line-height:8px;font-size:8px;">&nbsp;</td></tr>
              <tr>
                <td style="padding:10px 14px;background:#1c1c28;border:1px solid rgba(255,255,255,0.08);border-radius:10px;">
                  <div style="font-family:'JetBrains Mono',Menlo,monospace;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#a855f7;padding-bottom:4px;">AI debrief + CPD</div>
                  <div style="font-size:14px;line-height:1.5;color:#f5f2ec;">After the show, your team's notes and ratings feed into a shared AI debrief and CPD record — one place, everyone's insights.</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Security note -->
        <tr>
          <td class="px-32" style="padding:20px 40px 32px;">
            <div style="font-size:13px;line-height:1.55;color:#8c8a9e;">
              <strong style="color:#f5f2ec;">Wasn't expecting this?</strong> You can safely ignore this email — it doesn't do anything until you click the button above. Or reply and we'll help.
            </div>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="background:#1c1c28;padding:24px 40px;border-top:1px solid rgba(255,255,255,0.08);">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-size:12px;line-height:1.55;color:#8c8a9e;">
                  Sent by <a href="https://workiro.com" style="color:#8c8a9e;text-decoration:underline;">Workiro</a> · AutoEvent is a free planning tool for professional events.<br>
                  <a href="https://www.workiro.com/terms-and-policies/autoevent" style="color:#8c8a9e;text-decoration:underline;">Privacy &amp; terms</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>

</body>
</html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { inviteeEmail, inviteToken, inviterName, inviterCompany } =
      await req.json();

    if (!inviteeEmail || !inviteToken) {
      return new Response(
        JSON.stringify({ error: "inviteeEmail and inviteToken are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const encodedEmail = encodeURIComponent(inviteeEmail.toLowerCase());
    const isNewUser = !(await checkUserExists(inviteeEmail));

    const ctaUrl = isNewUser
      ? `${SITE_URL}/?team=${inviteToken}&email=${encodedEmail}`
      : `${SITE_URL}/login/?team=${inviteToken}&email=${encodedEmail}`;

    const subject = isNewUser
      ? `${inviterName || "A colleague"} has invited you to their Accountex 2026 plan`
      : `${inviterName || "A colleague"} wants you in their Accountex team`;

    const html = isNewUser
      ? buildNewUserEmail(inviterName, inviterCompany, ctaUrl)
      : buildExistingUserEmail(inviterName, inviterCompany, ctaUrl);

    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) {
      return new Response(
        JSON.stringify({ error: "RESEND_API_KEY secret not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const sendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "AutoEvent <hello@autoevent.io>",
        to: [inviteeEmail],
        subject,
        html,
      }),
    });

    if (!sendRes.ok) {
      const body = await sendRes.text();
      return new Response(
        JSON.stringify({ error: `Email API error: ${body}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ success: true, isNewUser }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
