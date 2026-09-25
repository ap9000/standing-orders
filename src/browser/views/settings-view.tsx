/** Settings, rebuilt with shadcn/ui. Every control posts to the same server
 * route as before (CSRF included); choices save the moment they change and
 * the server's confirmation arrives as a toast. */
import { BookOpen, ChevronDown, Cpu, Hash, LineChart, MessageSquare, Monitor, Moon, Send, Sparkles, Sun, Users, Wrench } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { BrowserSettingsView } from "../../browser-workspace.js";
import {
  Badge, Button, Card, CardDescription, CardHeader, CardTitle, Collapsible, CollapsibleContent, CollapsibleTrigger,
  Input, Label, RadioCard, RadioGroup, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Separator, cn, toast,
} from "../components/ui/index.js";

const TILE_ICONS: Record<string, ReactNode> = {
  "/settings/models": <Cpu />, "/settings/skills": <Sparkles />, "/settings/tools": <Wrench />, "/settings/knowledge": <BookOpen />, "/settings/telegram": <Send />,
  "/settings/slack": <Hash />, "/settings/discord": <MessageSquare />, "/settings/teams": <Users />, "/settings/learning": <LineChart />,
};

function Csrf({ csrf }: { csrf: string }) { return <input type="hidden" name="csrf" value={csrf} />; }

/** A form that submits itself when one of its choices changes. */
function AutoForm({ action, csrf, children, className }: { action: string; csrf: string; children: (submit: () => void) => ReactNode; className?: string }) {
  const form = useRef<HTMLFormElement>(null);
  // Radix writes the hidden value on the next tick; submit after it lands.
  const submit = () => setTimeout(() => form.current?.requestSubmit(), 0);
  return <form ref={form} method="post" action={action} className={className}><Csrf csrf={csrf} />{children(submit)}</form>;
}

function Section({ title, description, children, id }: { title: string; description?: string; children: ReactNode; id?: string }) {
  return <Card id={id} aria-labelledby={id ? `${id}-title` : undefined}>
    <CardHeader><div className="grid gap-1"><CardTitle id={id ? `${id}-title` : undefined}>{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}</div></CardHeader>
    {children}
  </Card>;
}

function StatusDot({ tone }: { tone: "ok" | "warn" | "off" | "neutral" }) {
  return <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", tone === "ok" && "bg-success", tone === "warn" && "bg-attention", tone === "neutral" && "bg-muted-foreground", tone === "off" && "border-[1.5px] border-muted-foreground")} />;
}

function Themes({ view, csrf }: { view: BrowserSettingsView; csrf: string }) {
  const options = [["system", "Match device", <Monitor key="m" />], ["light", "Light", <Sun key="s" />], ["dark", "Dark", <Moon key="d" />]] as const;
  return <form method="post" action="/settings/appearance" className="flex flex-wrap items-center gap-3">
    <Csrf csrf={csrf} />
    <div role="group" aria-label="Theme" className="inline-flex rounded-lg bg-muted p-1">
      {options.map(([value, label, icon]) => <button key={value} type="submit" name="theme" value={value} aria-pressed={view.theme === value}
        className={cn("inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground max-sm:h-11 [&_svg]:size-4", view.theme === value && "bg-card text-foreground shadow-sm")}>{icon}{label}</button>)}
    </div>
    <span className="text-[13px] text-muted-foreground">Saved in this browser.</span>
  </form>;
}

function DefaultChoice({ title, description, action, field, value, canManage, changed, options, csrf }: {
  title: string; description: string; action: string; field: string; value: string; canManage: boolean; changed: string | null; csrf: string;
  options: { value: string; title: string; description: string }[];
}) {
  const base = useId();
  const current = options.find(one => one.value === value);
  return <Section title={title} description={description}>
    {canManage ? <AutoForm action={action} csrf={csrf}>{submit => <>
      <RadioGroup name={field} defaultValue={value} onValueChange={submit} className="grid gap-2 sm:grid-cols-2" aria-label={title}>
        {options.map(one => <RadioCard key={one.value} id={`${base}-${one.value}`} value={one.value} title={one.title} description={one.description} />)}
      </RadioGroup>
      <noscript><Button type="submit" className="mt-3">Save</Button></noscript>
    </>}</AutoForm> : <p className="text-sm"><strong>{current?.title ?? value}</strong> <span className="text-muted-foreground">· an approver can change this</span></p>}
    {changed && <p className="text-[13px] text-muted-foreground">{changed}</p>}
  </Section>;
}

/** The email account: Send email steps send from it and Email inbox triggers read it — a mail server, or a
 * Google account instead. Passwords and the Google client secret are written here and never shown again. */
function Email({ email, csrf }: { email: NonNullable<BrowserSettingsView["email"]>; csrf: string }) {
  const google = email.google.connected;
  const status = google !== null ? `${google}, through Google` : email.set ? `From ${email.from} through ${email.host}${email.imapHost === "" ? "" : ` · reads ${email.imapHost}`}` : "Not set up";
  return <Section id="email" title="Email" description="Send email steps send from this account, and Email inbox triggers read it.">
    <Collapsible defaultOpen={!email.set && google === null}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-2 text-sm"><StatusDot tone={email.set || google !== null ? "ok" : "off"} />{status}</span>
        <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="ml-auto group">{email.set || google !== null ? "Change" : "Set up"}<ChevronDown className="transition-transform group-data-[state=open]:rotate-180" /></Button></CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        {google !== null
          ? <form method="post" action="/settings/google/disconnect" className="mt-3 grid gap-3 rounded-lg bg-muted p-4" data-google-connected>
              <Csrf csrf={csrf} />
              <p className="text-[13px]">Signed in with Google as <strong>{google}</strong>. Mail is sent and read through it.</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" variant="outline" formAction="/settings/email-test">Send a test email</Button>
                <Button type="submit" variant="outline" formAction="/settings/email-read-test">Check the inbox</Button>
                <Button type="submit" variant="ghost">Disconnect Google</Button>
              </div>
            </form>
          : <>
            <form method="post" action="/settings/email" className="mt-3 grid gap-3 rounded-lg bg-muted p-4" data-email-settings>
              <Csrf csrf={csrf} />
              <p className="text-[13px] text-muted-foreground">For Gmail: smtp.gmail.com, port 587, your address, and an app password. To read mail too, add imap.gmail.com.</p>
              <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
                <div className="grid gap-2"><Label htmlFor="email-host">Mail server</Label><Input id="email-host" name="host" defaultValue={email.host} placeholder="smtp.gmail.com" required /></div>
                <div className="grid gap-2"><Label htmlFor="email-port">Port</Label><Input id="email-port" name="port" type="number" min={1} max={65535} defaultValue={String(email.port)} required /></div>
              </div>
              <div className="grid gap-2"><Label htmlFor="email-from">Send from</Label><Input id="email-from" name="from" type="email" defaultValue={email.from} placeholder="you@example.com" required /></div>
              <div className="grid gap-2"><Label htmlFor="email-user">Username</Label><Input id="email-user" name="user" autoComplete="username" defaultValue={email.user} placeholder="Usually the same address" /></div>
              <div className="grid gap-2"><Label htmlFor="email-password">Password</Label><Input id="email-password" name="password" type="password" autoComplete="off" placeholder={email.set ? "Leave empty to keep the saved one" : "An app password"} /></div>
              <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="secure" className="size-4 accent-[var(--so-accent)]" defaultChecked={email.secure} />Use SSL from the start (port 465)</label>
              <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
                <div className="grid gap-2"><Label htmlFor="email-imap">Read mail from (optional)</Label><Input id="email-imap" name="imapHost" defaultValue={email.imapHost} placeholder="imap.gmail.com" /></div>
                <div className="grid gap-2"><Label htmlFor="email-imap-port">Port</Label><Input id="email-imap-port" name="imapPort" type="number" min={1} max={65535} defaultValue={String(email.imapPort)} /></div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit">Save email</Button>
                {email.set && <Button type="submit" variant="outline" formAction="/settings/email-test" formNoValidate>Send a test email</Button>}
                {email.set && email.imapHost !== "" && <Button type="submit" variant="outline" formAction="/settings/email-read-test" formNoValidate>Check the inbox</Button>}
              </div>
            </form>
            <details className="mt-3 rounded-lg border px-4 py-3" open={email.google.clientId !== "" && !email.set} data-google-setup>
              <summary className="cursor-pointer text-[13px] font-semibold">Or sign in with a Google account</summary>
              <form method="post" action="/settings/google" className="mt-3 grid gap-3">
                <Csrf csrf={csrf} />
                <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted-foreground">
                  <li>In Google Cloud Console, make an OAuth client of type <em>Web application</em>, and set the consent screen to <em>In production</em> (while it's in Testing, Google ends the connection after 7 days).</li>
                  {email.google.redirect === null
                    ? <li>Open these settings on this computer (localhost) or at your https address to see the redirect address to add.</li>
                    : <li>Add this as an authorized redirect address: <code className="break-all rounded bg-muted px-1 py-0.5 text-foreground" data-google-redirect>{email.google.redirect}</code></li>}
                  <li>Paste the client ID and secret here, then connect. Google warns that it hasn't verified the app: it's your own, so continue.</li>
                </ol>
                <div className="grid gap-2"><Label htmlFor="google-id">Client ID</Label><Input id="google-id" name="clientId" defaultValue={email.google.clientId} placeholder="….apps.googleusercontent.com" required /></div>
                <div className="grid gap-2"><Label htmlFor="google-secret">Client secret</Label><Input id="google-secret" name="clientSecret" type="password" autoComplete="off" placeholder={email.google.clientId !== "" ? "Leave empty to keep the saved one" : ""} /></div>
                <Button type="submit" className="justify-self-start" disabled={email.google.redirect === null}>Connect Google</Button>
              </form>
            </details>
          </>}
      </CollapsibleContent>
    </Collapsible>
  </Section>;
}

function Providers({ providers, csrf }: { providers: NonNullable<BrowserSettingsView["providers"]>; csrf: string }) {
  return <Section id="providers" title="AI providers" description="Keys stay on this computer and are never shown again.">
    <ul className="-my-1 divide-y divide-border">
      {providers.map(one => <li key={one.provider} className="py-2">
        <Collapsible>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold">{one.name}</span>
            <span className="inline-flex items-center gap-2 text-sm text-muted-foreground"><StatusDot tone={one.tone} />{one.words}</span>
            <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="ml-auto group">Manage<ChevronDown className="transition-transform group-data-[state=open]:rotate-180" /></Button></CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <form method="post" action="/settings/provider-key" className="mt-3 grid gap-3 rounded-lg bg-muted p-4">
              <Csrf csrf={csrf} /><input type="hidden" name="provider" value={one.provider} />
              {one.connection && <p className="provider-connection text-sm"><strong>{one.connection.words}</strong> {one.connection.facts} · <a className="underline underline-offset-4" href={one.connection.checkHref}>Check again</a></p>}
              <p className="text-[13px] text-muted-foreground">{one.usage} · <code className="font-mono text-xs">{one.envName}</code></p>
              {one.subscriptionCapable && <div className="grid gap-2"><Label htmlFor={`${one.provider}-auth`}>Sign-in</Label>
                <Select name="auth-mode" defaultValue={one.mode}>
                  <SelectTrigger id={`${one.provider}-auth`}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="subscription">{one.name} subscription</SelectItem><SelectItem value="api-key">API key</SelectItem></SelectContent>
                </Select></div>}
              <div className="grid gap-2"><Label htmlFor={`${one.provider}-key`}>API key</Label>
                <Input id={`${one.provider}-key`} type="password" name="value" autoComplete="off" placeholder={one.set ? "Paste to replace the stored key" : "Paste a key"} /></div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit">Save {one.name}</Button>
                {one.set && <Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="text-destructive">Remove the stored key</Button></CollapsibleTrigger>
                  <CollapsibleContent className="mt-2 grid gap-2"><p className="text-[13px] text-muted-foreground">Runs that use this API key stop until you add one again.</p>
                    <Button type="submit" variant="destructive" size="sm" formAction="/settings/provider-key-clear">Remove key</Button></CollapsibleContent></Collapsible>}
              </div>
            </form>
          </CollapsibleContent>
        </Collapsible>
      </li>)}
    </ul>
  </Section>;
}

function Notifications({ view, csrf }: { view: BrowserSettingsView; csrf: string }) {
  const base = useId();
  if (view.services === null && view.push === null && view.digest === null) return null;
  return <Section title="Notifications">
    {view.services && (view.services.configured.length === 1 && !view.services.implicit
      ? <div className="flex items-center gap-3"><span className="font-semibold capitalize">{view.services.configured[0]}</span><span className="inline-flex items-center gap-2 text-sm text-muted-foreground"><StatusDot tone="ok" />Receiving alerts</span></div>
      : <AutoForm action="/settings/messaging" csrf={csrf}>{submit => <div className="grid gap-2">
        <Label>Alert service</Label>
        {view.services!.implicit && <p className="text-[13px] text-attention">Several are connected and none was chosen. Pick one.</p>}
        <RadioGroup name="primary" {...(view.services!.channel === null ? {} : { defaultValue: view.services!.channel })} onValueChange={submit} className="grid gap-2 sm:grid-cols-2">
          {view.services!.configured.map(one => <RadioCard key={one} id={`${base}-${one}`} value={one} title={one.charAt(0).toUpperCase() + one.slice(1)} description={one === "telegram" ? "Answer buttons and replies" : "Messages with links"} />)}
        </RadioGroup></div>}</AutoForm>)}
    {view.push && <>
      <Separator />
      <div className="grid gap-3">
        <div className="grid gap-1"><span className="font-semibold">This device</span>
          <span className="text-[13px] text-muted-foreground">{view.push.available ? "A notification when something needs you. On iPhone, add this app to your Home Screen first." : "Alerts need a secure (https) address for this app."}</span></div>
        {view.push.available && <form method="post" action="/push/subscribe" id="push-form" className="flex flex-wrap items-end gap-3">
          <Csrf csrf={csrf} /><input type="hidden" name="endpoint" value="" /><input type="hidden" name="p256dh" value="" /><input type="hidden" name="auth" value="" />
          <div className="grid min-w-56 flex-1 gap-2"><Label htmlFor="push-password">Your password</Label><Input id="push-password" type="password" name="token" autoComplete="current-password" /></div>
          <Button type="submit" id="push-enable" variant="outline">Get alerts on this device</Button>
          <p className="w-full text-[13px] text-muted-foreground" id="push-state" aria-live="polite"></p>
        </form>}
        {view.push.devices.length > 0 && <ul className="grid gap-2">{view.push.devices.map(one => <li key={one.id} className="flex flex-wrap items-center gap-3 text-sm">
          <span>{one.words}</span>{one.state !== "ok" && <Badge tone={one.state === "failing" ? "warning" : "neutral"}>{one.state}</Badge>}
          {one.removable && <form method="post" action="/push/remove" className="ml-auto"><Csrf csrf={csrf} /><input type="hidden" name="id" value={one.id} /><Button type="submit" variant="ghost" size="sm">Remove</Button></form>}
        </li>)}</ul>}
      </div>
    </>}
    {view.digest && <>
      <Separator />
      <AutoForm action="/settings/telegram-digest" csrf={csrf} className="grid gap-2">{submit => <>
        <Label htmlFor={`${base}-digest`}>Telegram digest</Label>
        <p className="text-[13px] text-muted-foreground">Bundle routine updates. Anything that needs you still arrives at once.</p>
        <Select name="every" defaultValue={view.digest!.every} onValueChange={submit}>
          <SelectTrigger id={`${base}-digest`} className="sm:max-w-72"><SelectValue /></SelectTrigger>
          <SelectContent>{[["off", "Off: send each update"], ["30", "Every 30 minutes"], ["60", "Every hour"], ["240", "Every 4 hours"], ["720", "Every 12 hours"], ["1440", "Once a day"]].map(([value, label]) => <SelectItem key={value} value={value!}>{label}</SelectItem>)}</SelectContent>
        </Select>
        {view.digest!.held && <p className="text-[13px] text-muted-foreground">{view.digest!.held}</p>}
      </>}</AutoForm>
    </>}
  </Section>;
}

function TelegramToken({ view, csrf }: { view: BrowserSettingsView; csrf: string }) {
  return <Collapsible className="rounded-lg border border-border bg-card">
    <CollapsibleTrigger asChild><button className="group flex w-full items-center justify-between gap-3 px-5 py-4 text-left max-sm:px-4">
      <span className="font-semibold">Telegram bot token <span className="ml-2 text-sm font-normal text-muted-foreground">{view.telegram.state}</span></span>
      <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </button></CollapsibleTrigger>
    <CollapsibleContent className="grid gap-3 border-t border-border px-5 py-4 max-sm:px-4">
      <p className="text-[13px] text-muted-foreground">Current: {view.telegram.current}</p>
      <form method="post" action="/settings/telegram-token" className="flex flex-wrap items-end gap-3">
        <Csrf csrf={csrf} />
        <div className="grid min-w-56 flex-1 gap-2"><Label htmlFor="telegram-token-field">Token from @BotFather</Label><Input id="telegram-token-field" type="password" name="token" autoComplete="off" /></div>
        <Button type="submit" variant="outline">Save token</Button>
      </form>
      <p className="text-[13px] text-muted-foreground">Stored privately on this computer. Then pair your phone under <a className="underline underline-offset-4" href="/settings/telegram">Telegram</a>.</p>
    </CollapsibleContent>
  </Collapsible>;
}

export function SettingsView({ view, csrf }: { view: BrowserSettingsView; csrf: string }) {
  const [said] = useState(view.said);
  useEffect(() => { if (said) toast(said.charAt(0).toUpperCase() + said.slice(1)); }, [said]);
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
    <h1 className="sr-only">Settings</h1>
    <nav aria-label="Settings sections" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {view.tiles.map(tile => <a key={tile.href} href={tile.href} className="flex min-h-12 items-center gap-2.5 rounded-lg border border-border bg-card px-3 text-sm font-semibold transition-colors hover:bg-accent [&_svg]:size-[18px] [&_svg]:text-primary">
        {TILE_ICONS[tile.href]}{tile.label}</a>)}
    </nav>
    <Section title="Appearance"><Themes view={view} csrf={csrf} /></Section>
    {view.permission && <DefaultChoice title="Unattended permissions" description="The starting choice for new tasks. Approved tasks keep their setting." action="/settings/permission-default" field="permission-mode"
      value={view.permission.mode} canManage={view.permission.canManage} changed={view.permission.changed} csrf={csrf}
      options={[{ value: "auto", title: "Auto", description: "Asks before risky actions." }, { value: "bypassPermissions", title: "Full access", description: "Never asks and can change files anywhere on this computer. Trusted repositories only." }]} />}
    {view.quality && <DefaultChoice title="Quality mode" description="Publishing and deploying still need their own approval." action="/settings/quality-default" field="quality-mode"
      value={view.quality.mode} canManage={view.quality.canManage} changed={view.quality.changed} csrf={csrf}
      options={[{ value: "default", title: "Default", description: "Everyday agents and the repository check." }, { value: "strict", title: "Strict / release", description: "Strongest agents. Release approval stays separate." }]} />}
    {view.providers && <Providers providers={view.providers} csrf={csrf} />}
    {view.email && csrf && <Email email={view.email} csrf={csrf} />}
    <Notifications view={view} csrf={csrf} />
    {csrf && <TelegramToken view={view} csrf={csrf} />}
  </div>;
}
