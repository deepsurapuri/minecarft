#!/usr/bin/env python3
"""
Minimal AI-agent client for the Minecraft AI gateway. Standard library only.

Two modes:

  1) Scripted demo (default): spawn a bot, say hi, teleport, read chat, leave.
       AI_GATEWAY_KEY=mcai_... python3 examples/python_agent.py

  2) LLM tool-use loop: any OpenAI-compatible chat-completions endpoint drives
     the gateway as tools. The model decides how to act in your world.
       OPENAI_API_KEY=sk-... AI_GATEWAY_KEY=mcai_... \
         python3 examples/python_agent.py --llm "join the game and greet everyone"

Env vars:
  AI_GATEWAY_URL        gateway base URL          (default http://127.0.0.1:3000)
  AI_GATEWAY_KEY        gateway API key           (required)
  BOT_AUTH              offline | microsoft       (default offline)
  BOT_NAME              bot username               (default AIBot py)
  LLM_BASE_URL          OpenAI-compatible root    (default https://api.openai.com/v1)
  LLM_MODEL             model name                 (default gpt-4o-mini)
  OPENAI_API_KEY        key for the LLM endpoint  (--llm mode only)
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error

BASE_URL = os.environ.get('AI_GATEWAY_URL', 'http://127.0.0.1:3000').rstrip('/')
GATEWAY_KEY = os.environ.get('AI_GATEWAY_KEY')
BOT_AUTH = os.environ.get('BOT_AUTH', 'offline')
BOT_NAME = os.environ.get('BOT_NAME', 'AIBotpy')
LLM_BASE_URL = os.environ.get('LLM_BASE_URL', 'https://api.openai.com/v1').rstrip('/')
LLM_MODEL = os.environ.get('LLM_MODEL', 'gpt-4o-mini')


def die(message, code=1):
    print(f'error: {message}', file=sys.stderr)
    sys.exit(code)


def http_json(method, url, api_key, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {'Authorization': f'Bearer {api_key}'}
    if data:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read().decode() or '{}'
            return response.status, json.loads(payload)
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode() or '{}'
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            payload = {'raw': payload}
        return exc.code, payload
    except urllib.error.URLError as exc:
        die(f'could not reach {url}: {exc.reason}')


def gateway(method, path, body=None):
    status, payload = http_json(method, f'{BASE_URL}{path}', GATEWAY_KEY, body)
    if status >= 400:
        error = payload.get('error', {})
        die(f'gateway returned {status}: {error.get("code")}: {error.get("message")}')
    return payload


# ---------------------------------------------------------------- scripted demo
def scripted_demo():
    print('== checking server status ==')
    try:
        print(json.dumps(gateway('GET', '/v1/server/status'), indent=2))
    except SystemExit:
        raise
    except Exception as exc:  # status is advisory — keep going
        print(f'(status check skipped: {exc})')

    print('\n== spawning bot ==')
    bot = gateway('POST', '/v1/bots', {'username': BOT_NAME, 'auth': BOT_AUTH})
    print(json.dumps(bot, indent=2))
    bot_id = bot['id']

    # Poll until the bot finishes connecting (online-mode servers may also need
    # you to complete the Xbox device-code flow printed below).
    print('\n== waiting for bot to come online ==', end='', flush=True)
    deadline = time.time() + (300 if BOT_AUTH == 'microsoft' else 30)
    online = False
    while time.time() < deadline:
        status = gateway('GET', f'/v1/bots/{bot_id}')
        if status['status'] == 'online':
            online = True
            print(' online!')
            break
        if status['status'] == 'awaiting_device_code':
            msa = status.get('msa') or {}
            print(f"\nMicrosoft sign-in required: open {msa.get('url')} and enter code {msa.get('deviceCode')}")
            deadline = time.time() + 300  # human needs a few minutes
        elif status['status'] in ('disconnected', 'kicked', 'error'):
            die(f"bot never came online (status={status['status']}, last error={status.get('lastError')})")
        print('.', end='', flush=True)
        time.sleep(1)
    if not online:
        die('timed out waiting for the bot to come online')

    print('\n== saying hello ==')
    print(gateway('POST', f'/v1/bots/{bot_id}/chat', {'message': 'Hello! An AI agent joined through the gateway API.'}))

    print('\n== teleporting to spawn-ish coordinates (0 64 0) ==')
    print(gateway('POST', f'/v1/bots/{bot_id}/teleport', {'x': 0, 'y': 64, 'z': 0}))

    print('\n== recent chat ==')
    print(json.dumps(gateway('GET', f'/v1/bots/{bot_id}/chat'), indent=2))

    print('\n== removing bot ==')
    print(gateway('DELETE', f'/v1/bots/{bot_id}'))


# ------------------------------------------------------------------ llm tool use
TOOLS = [
    {
        'type': 'function',
        'function': {
            'name': 'spawn_bot',
            'description': 'Spawn a bot in the Minecraft world. Call this first.',
            'parameters': {'type': 'object', 'properties': {
                'username': {'type': 'string'}}, 'required': ['username']},
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'list_bots',
            'description': 'List the bots this gateway is running.',
            'parameters': {'type': 'object', 'properties': {}},
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'send_chat',
            'description': 'Send a chat message as a bot.',
            'parameters': {'type': 'object', 'properties': {
                'bot_id': {'type': 'string'}, 'message': {'type': 'string'}}, 'required': ['bot_id', 'message']},
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'read_chat',
            'description': 'Read recent chat messages for a bot.',
            'parameters': {'type': 'object', 'properties': {
                'bot_id': {'type': 'string'}}, 'required': ['bot_id']},
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'run_command',
            'description': 'Run a Minecraft cheat command as an operator bot, e.g. "time set day", "give @s minecraft:diamond 3", "tp @s Steve". Do NOT include the leading slash.',
            'parameters': {'type': 'object', 'properties': {
                'bot_id': {'type': 'string'}, 'command': {'type': 'string'}}, 'required': ['bot_id', 'command']},
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'teleport',
            'description': 'Teleport a bot to absolute coordinates, or to a player.',
            'parameters': {'type': 'object', 'properties': {
                'bot_id': {'type': 'string'},
                'x': {'type': 'number'}, 'y': {'type': 'number'}, 'z': {'type': 'number'},
                'to': {'type': 'string', 'description': 'player name to teleport to'}},
                'required': ['bot_id']},
        },
    },
    {
        'type': 'function',
        'function': {
            'name': 'remove_bot',
            'description': 'Disconnect and remove a bot.',
            'parameters': {'type': 'object', 'properties': {
                'bot_id': {'type': 'string'}}, 'required': ['bot_id']},
        },
    },
]


def call_tool(name, arguments):
    match = {
        'spawn_bot': lambda a: gateway('POST', '/v1/bots', {'username': a['username'], 'auth': BOT_AUTH}),
        'list_bots': lambda a: gateway('GET', '/v1/bots'),
        'send_chat': lambda a: gateway('POST', f"/v1/bots/{a['bot_id']}/chat", {'message': a['message']}),
        'read_chat': lambda a: gateway('GET', f"/v1/bots/{a['bot_id']}/chat"),
        'run_command': lambda a: gateway('POST', f"/v1/bots/{a['bot_id']}/command", {'command': a['command']}),
        'teleport': lambda a: gateway('POST', f"/v1/bots/{a['bot_id']}/teleport",
                                       {k: v for k, v in a.items() if k != 'bot_id'}),
        'remove_bot': lambda a: gateway('DELETE', f"/v1/bots/{a['bot_id']}"),
    }.get(name)
    if match is None:
        return {'error': f'unknown tool {name}'}
    try:
        return match(arguments)
    except SystemExit:
        return {'error': 'tool call failed (see stderr above)'}


def llm_loop(prompt):
    llm_key = os.environ.get('OPENAI_API_KEY')
    if not llm_key:
        die('--llm mode needs OPENAI_API_KEY (any OpenAI-compatible key works)')

    messages = [
        {'role': 'system', 'content': (
            'You are an AI agent operating inside a Minecraft Bedrock world through an HTTP gateway. '
            'Call spawn_bot first, then read_chat/list_bots periodically — sending chat or commands before the bot is online returns 409. '
            'Be brief in chat. '
            'When the task is complete, summarise what you did and stop calling tools.')},
        {'role': 'user', 'content': prompt},
    ]

    for _ in range(20):  # hard cap on tool-call rounds
        status, response = http_json('POST', f'{LLM_BASE_URL}/chat/completions', llm_key, {
            'model': LLM_MODEL,
            'messages': messages,
            'tools': TOOLS,
            'tool_choice': 'auto',
        })
        if status >= 400:
            die(f'LLM endpoint returned {status}: {json.dumps(response)[:500]}')

        choice = response['choices'][0]['message']
        messages.append(choice)

        tool_calls = choice.get('tool_calls') or []
        if not tool_calls:
            print('\n=== agent finished ===')
            print(choice.get('content') or '(no content)')
            return

        for tool_call in tool_calls:
            name = tool_call['function']['name']
            try:
                arguments = json.loads(tool_call['function'].get('arguments') or '{}')
            except json.JSONDecodeError:
                arguments = {}
            print(f'-- tool: {name}({json.dumps(arguments)})')
            result = call_tool(name, arguments)
            print(f'   -> {json.dumps(result)[:300]}')
            messages.append({
                'role': 'tool',
                'tool_call_id': tool_call['id'],
                'content': json.dumps(result),
            })

    print('Stopped after 20 tool-call rounds (safety cap).')


def main():
    if not GATEWAY_KEY:
        die('set AI_GATEWAY_KEY (mint one with: docker compose exec gateway node src/cli.js keys create --name agent --scopes bot:control,bot:command)')

    parser = argparse.ArgumentParser(description='AI agent example for the Minecraft gateway')
    parser.add_argument('--llm', metavar='TASK', help='Let an LLM drive the gateway toward TASK')
    args = parser.parse_args()

    if args.llm:
        llm_loop(args.llm)
    else:
        scripted_demo()


if __name__ == '__main__':
    main()
