/*
 * sd-puppet.js — パーツ分けしたキャラを Live2D 風に動かす部品（依存なし / WebGL）
 *
 *   <script src="sd-puppet.js"></script>
 *   <sd-puppet src="yuka-p/" size="300"></sd-puppet>   （src 省略時はこのファイルと同じ場所の yuka/）
 *
 * JS:
 *   el.react('happy' | 'surprise' | 'shy' | 'nod' | 'spin')
 *   el.popAt(buttonElement)        ボタンの後ろからひょこっ
 *   el.lookAt(x, y)                画面座標を見る
 *   el.setManual({yaw, pitch})     手動で向きを指定（-1..1）。null で解除
 *   el.talk(ms)                    口パク
 *   el.pose('左を指す', ms)        ポーズの絵に一時的に差し替え（tools/build_poses.py で追加したもの）
 *   属性 max-dpr="1.5"            描画の細かさの上限（大きく表示する時に下げると軽い。既定 2）
 *
 * 素材フォルダ: parts.webp / puppet.json （tools/build_puppet.py で生成）
 */
(() => {
  'use strict';
  // このファイルの置き場所（src を省略した時は、同じ場所の yuka/ を読む）
  const SCRIPT_BASE = document.currentScript ? document.currentScript.src.replace(/[^/]*$/, '') : './';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const rand = (a, b) => a + Math.random() * (b - a);

  class Spring {
    constructor(v = 0, k = 120, d = 14) { this.v = v; this.t = v; this.vel = 0; this.k = k; this.d = d; }
    step(dt) { const a = this.k * (this.t - this.v) - this.d * this.vel; this.vel += a * dt; this.v += this.vel * dt; return this.v; }
    kick(i) { this.vel += i; }
    set(v) { this.v = this.t = v; this.vel = 0; }
  }

  const VS = `
attribute vec2 aPos; attribute vec2 aUV;
uniform vec2 uCanvas; varying vec2 vUV;
void main(){ vUV = aUV; vec2 c = aPos / uCanvas * 2.0 - 1.0; gl_Position = vec4(c.x, -c.y, 0.0, 1.0); }`;
  const FS = `
precision mediump float;
varying vec2 vUV; uniform sampler2D uTex; uniform float uAlpha; uniform float uCut;
void main(){ vec4 c = texture2D(uTex, vUV); if (c.a < uCut) discard; gl_FragColor = c * uAlpha; }`;

  const MAX_YAW = 0.4, MAX_PITCH = 0.3;   // 顔の向きの最大角（rad）

  class SDPuppet extends HTMLElement {
    static get observedAttributes() { return ['size']; }
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `
<style>
  :host{ display:inline-block; position:relative; touch-action:none; user-select:none; -webkit-user-select:none;
         -webkit-tap-highlight-color:transparent; cursor:pointer; vertical-align:bottom; }
  canvas{ position:absolute; pointer-events:none; }
  .shadow{ position:absolute; left:50%; bottom:-1.5%; width:58%; height:5%; transform:translateX(-50%);
           background:radial-gradient(closest-side, rgba(0,0,0,.26), rgba(0,0,0,0)); border-radius:50%; pointer-events:none; }
  .fx{ position:absolute; inset:0; pointer-events:none; overflow:visible; }
  .p{ position:absolute; will-change:transform,opacity; pointer-events:none; font:700 16px/1 system-ui,sans-serif; }
</style>
<div class="shadow"></div><canvas></canvas><div class="fx"></div>`;
      this.canvas = root.querySelector('canvas');
      this.shadowEl = root.querySelector('.shadow');
      this.fx = root.querySelector('.fx');
      this.ready = false;
    }
    // 描画ループ（ページから外れたら止める＝見えないまま電池を使わない）
    _run() {
      if (this._looping) return;
      this._looping = true; this._last = performance.now();
      const loop = (t) => {
        if (!this.isConnected) { this._looping = false; return; }
        requestAnimationFrame(loop); this._tick(t);
      };
      requestAnimationFrame(loop);
    }
    connectedCallback() {
      if (this.ready) this._run();
      if (this._started) return;
      this._started = true;
      this._load(this.getAttribute('src') || SCRIPT_BASE + 'yuka/').catch(e => console.error('[sd-puppet]', e));
    }
    attributeChangedCallback() { if (this.ready) this._layout(); }

    async _load(src) {
      if (!src.endsWith('/')) src += '/';
      const loadImg = (u) => new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = u; });   // 別サイトから読んでもWebGLで使えるように
      // puppet.json は毎回最新を取り、画像はその版番号つきで読む（作り直した時に古い画像が残らないように）
      const meta = await fetch(src + 'puppet.json', { cache: 'no-cache' }).then(r => r.json());
      const ver = meta.version ? '?v=' + meta.version : '';
      const img = await loadImg(src + 'parts.webp' + ver);
      // 表情パーツ（あれば）
      const exprImg = meta.expressions && meta.expressions.length ? await loadImg(src + 'expr.webp' + ver).catch(() => null) : null;
      // くるっと回るコマ画像（あれば）
      const spinImg = meta.spin ? await loadImg(src + 'spin.webp' + ver).catch(() => null) : null;
      // ポーズ違いの全身の絵（あれば）
      const poseImg = meta.poses && meta.poses.items.length ? await loadImg(src + 'pose.webp' + ver).catch(() => null) : null;
      this.meta = meta; this.rig = meta.rig; this.img = img; this.exprImg = exprImg; this.spinImg = spinImg; this.poseImg = poseImg;
      const b = this.rig.bounds;
      this.bx = b[0]; this.by = b[1]; this.BW = b[2] - b[0]; this.BH = b[3] - b[1];
      this.padX = this.BW * 0.35; this.padTop = this.BH * 0.22; this.padBot = this.BH * 0.04;
      this.CW = this.BW + this.padX * 2; this.CH = this.BH + this.padTop + this.padBot;
      this._initGL();
      this._initState();
      this._layout();
      this._bind();
      this.ready = true;
      this._last = performance.now();
      this._run();
      this.dispatchEvent(new CustomEvent('ready'));
    }

    _layout() {
      const size = parseFloat(this.getAttribute('size') || '200');
      this.scale = size / this.BH;
      const s = this.scale, dpr = Math.min(window.devicePixelRatio || 1, parseFloat(this.getAttribute('max-dpr') || '2'));   // 大きく表示する時は max-dpr を下げると軽くなる
      this.style.width = (this.BW * s) + 'px';
      this.style.height = (this.BH * s) + 'px';
      Object.assign(this.canvas.style, {
        left: (-this.padX * s) + 'px', top: (-this.padTop * s) + 'px',
        width: (this.CW * s) + 'px', height: (this.CH * s) + 'px'
      });
      this.canvas.width = Math.round(this.CW * s * dpr);
      this.canvas.height = Math.round(this.CH * s * dpr);
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    // ---------- WebGL / メッシュ ----------
    _initGL() {
      const gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: true, stencil: true });
      if (!gl) throw new Error('WebGL not supported');
      this.gl = gl;
      const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(pr); gl.useProgram(pr);
      this.u = {}; ['uCanvas', 'uTex', 'uAlpha', 'uCut'].forEach(n => this.u[n] = gl.getUniformLocation(pr, n));

      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      const pot = (n) => (n & (n - 1)) === 0;
      const mkTex = (im) => {
        const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
        if (pot(im.width) && pot(im.height)) {
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      this.tex = [mkTex(this.img)];
      const sizes = [this.meta.atlas];
      // 表情パーツは顔のすぐ上に差し込む（照れの頬・前髪はその上に重なる）
      let list = this.meta.parts.map(p => Object.assign({ tex: 0 }, p));
      if (this.exprImg) {
        this.tex.push(mkTex(this.exprImg)); sizes.push(this.meta.exprAtlas);
        const ex = this.meta.expressions.map(e => Object.assign({ tex: 1, group: 'head', depth: 0.72, expr: true }, e));
        const at = list.findIndex(p => p.name === 'face');
        list.splice(at < 0 ? list.length : at + 1, 0, ...ex);
      }
      if (this.spinImg) {
        const sp = this.meta.spin;
        this.tex.push(mkTex(this.spinImg)); sizes.push(sp.atlas);
        list.push({ name: 'spin', spin: true, tex: this.tex.length - 1, group: 'spin', depth: 0,
                    x: sp.x, y: sp.y, w: sp.w, h: sp.h, u: 0, v: 0, uw: sp.cellW, vh: sp.cellH });
      }

      if (this.poseImg) {
        const PS = this.meta.poses;
        this.tex.push(mkTex(this.poseImg)); sizes.push(PS.atlas);
        for (const q of PS.items) list.push(Object.assign({ pose: true, tex: this.tex.length - 1, group: 'pose', depth: 0 }, q, { name: 'pose:' + q.name }));
      }

      // パーツごとに格子メッシュを作り、1本のバッファにまとめる
      const rest = [], uv = [], idx = [];
      this.parts = list.map(p => {
        const [AW, AH] = sizes[p.tex];
        const nx = clamp(Math.ceil(p.w / 14), 1, 28), ny = clamp(Math.ceil(p.h / 14), 1, 28);
        const v0 = rest.length / 2, i0 = idx.length;
        for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
          const fx = i / nx, fy = j / ny;
          rest.push(p.x + fx * p.w, p.y + fy * p.h);
          uv.push((p.u + fx * (p.uw || p.w)) / AW, (p.v + fy * (p.vh || p.h)) / AH);
        }
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          const a = v0 + j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
          idx.push(a, b, c, b, d, c);
        }
        return Object.assign({}, p, { v0, vn: (nx + 1) * (ny + 1), i0, in: idx.length - i0, alpha: p.expr ? 0 : 1 });
      });
      this.byName = {}; this.parts.forEach(p => this.byName[p.name] = p);
      this.rest = new Float32Array(rest);
      this.pos = new Float32Array(rest.length);
      const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
      const ub = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ub);
      this.uvArr = new Float32Array(uv); this.uvBuf = ub;
      gl.bufferData(gl.ARRAY_BUFFER, this.uvArr, gl.DYNAMIC_DRAW);
      const aUV = gl.getAttribLocation(pr, 'aUV'); gl.enableVertexAttribArray(aUV); gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
      this.posBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.pos, gl.DYNAMIC_DRAW);
      const aPos = gl.getAttribLocation(pr, 'aPos'); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1i(this.u.uTex, 0);
      gl.uniform2f(this.u.uCanvas, this.CW, this.CH);

      // 目のパーツの情報（まつ毛の中心など）
      this.eyeInfo = {};
      for (const e of this.rig.eyes) {
        const lash = this.byName['eyelash-' + e.side];
        this.eyeInfo[e.side] = { e, lash };
      }
      // 顔の傾き（左右の目を結ぶ線の角度）。まぶた・口・眉はこの傾きに沿って動かす
      const er = this.rig.eyes.find(e => e.side === 'r'), el = this.rig.eyes.find(e => e.side === 'l');
      this.tilt = Math.atan2(el.cy - er.cy, el.cx - er.cx);
      this.tc = Math.cos(this.tilt); this.ts = Math.sin(this.tilt);
      for (const k in this.eyeInfo) {
        const I = this.eyeInfo[k], E = I.e, L = I.lash;
        const lx = L ? L.x + L.w / 2 : E.cx, ly = L ? L.y + L.h / 2 : E.cy - E.h * 0.4;
        I.lashL = -(lx - E.cx) * this.ts + (ly - E.cy) * this.tc;   // まつ毛中心（顔の傾きに沿った座標）
        I.lidL = E.h * 0.2;                                         // 閉じる位置
      }
      const m = this.rig.mouth; this.mouthC = [(m[0] + m[2]) / 2, (m[1] + m[3]) / 2];
      // 腕の支点（右腕=スマホの手はひじ、左腕は肩）
      const ar = this.byName['handwear-r'], al = this.byName['handwear-l'], sk = this.byName['bottomwear'];
      this.pivR = ar ? [ar.x + ar.w * 0.3, ar.y + ar.h * 0.92] : null;
      this.pivL = al ? [al.x + al.w * 0.3, al.y + al.h * 0.06] : null;
      this.skirtY = sk ? [sk.y, sk.y + sk.h] : null;
    }

    // ---------- 状態 ----------
    _initState() {
      this.t = 0;
      this.S = {
        yaw: new Spring(0, 70, 12), pitch: new Spring(0, 70, 12), roll: new Spring(0, 90, 10),
        bodyYaw: new Spring(0, 40, 10), lean: new Spring(0, 80, 9),
        headX: new Spring(0, 140, 12), headY: new Spring(0, 140, 12),
        eyeX: new Spring(0, 260, 24), eyeY: new Spring(0, 260, 24),
        hairF: new Spring(0, 70, 5), hairB: new Spring(0, 45, 4), hairY: new Spring(0, 90, 6),
        squash: new Spring(0, 260, 13), scaleX: new Spring(1, 200, 16),
        mouth: new Spring(0, 300, 22), blush: new Spring(0, 18, 8),
        brow: new Spring(0, 160, 14), wide: new Spring(0, 160, 14),
        popY: new Spring(0, 170, 15),
        armR: new Spring(0, 120, 9), armL: new Spring(0, 60, 5),   // 腕の回転（rad）
        hip: new Spring(0, 80, 10), skirt: new Spring(0, 70, 4),   // 腰の横移動・スカートの遅れ
      };
      this.grooveUntil = 0;
      this.jumpY = 0; this.jumpV = 0;
      this.open = 1; this.lidHold = 0; this.happyEye = 0; this.blinkPhase = -1; this.blinkT = rand(1.5, 3.5);
      this.look = null; this.manual = null;
      this.lastInput = performance.now();
      this.idleT = rand(2, 4);
      this.mood = 'idle';
      this.pet = { active: false, dist: 0, lastX: 0, lastY: 0, heartT: 0 };
      this.breathRate = 1; this.prevHead = 0; this.zT = 0; this.talkUntil = 0;
    }

    // ---------- 入力 ----------
    _bind() {
      window.addEventListener('pointermove', (e) => {
        this.lastInput = performance.now();
        if (this.mood === 'sleep') this._wake(false);
        this.look = { x: e.clientX, y: e.clientY, t: performance.now() };
        const hit = this._hit(e.clientX, e.clientY);
        if (hit === 'head' && (e.buttons || e.pointerType === 'mouse')) {
          const d = Math.hypot(e.clientX - this.pet.lastX, e.clientY - this.pet.lastY);
          if (d < 80) this.pet.dist += d * (e.buttons ? 1 : 0.5);
          if (this.pet.dist > 90) this._petting(e);
        }
        this.pet.lastX = e.clientX; this.pet.lastY = e.clientY;
      }, { passive: true });
      window.addEventListener('pointerdown', (e) => {
        this.lastInput = performance.now();
        this.look = { x: e.clientX, y: e.clientY, t: performance.now() };
        if (this.mood === 'sleep') { this._wake(true); return; }
        if (!this._hit(e.clientX, e.clientY)) { this.S.squash.kick(-1.0); if (Math.random() < 0.4) this._blink(); }
      }, { passive: true });
      this.addEventListener('pointerdown', (e) => {
        this.pet.dist = 0; this.pet.lastX = e.clientX; this.pet.lastY = e.clientY;
        this._downT = performance.now(); this._downPos = [e.clientX, e.clientY];
        clearTimeout(this._lp);
        this._lp = setTimeout(() => { if (!this.pet.active) this.react('spin'); this._downT = 0; }, 650);
      });
      this.addEventListener('pointermove', (e) => {
        if (this._downT && Math.hypot(e.clientX - this._downPos[0], e.clientY - this._downPos[1]) > 12) clearTimeout(this._lp);
      });
      const up = () => {
        clearTimeout(this._lp);
        const quick = this._downT && performance.now() - this._downT < 350;
        if (this.pet.active) this._endPet();
        else if (quick && this.mood !== 'sleep') this.react(Math.random() < 0.5 ? 'surprise' : 'happy');
        this._downT = 0;
      };
      this.addEventListener('pointerup', up);
      this.addEventListener('pointercancel', up);
      this.addEventListener('pointerleave', () => { if (this.pet.active) this._endPet(); });
      document.addEventListener('visibilitychange', () => { this._last = performance.now(); });
      new IntersectionObserver(([en]) => { this._offscreen = !en.isIntersecting; this._last = performance.now(); }).observe(this);
    }

    _hit(x, y) {
      const rc = this.getBoundingClientRect(), s = this.scale;
      const px = (x - rc.left) / s + this.bx, py = (y - rc.top) / s + this.by + this.S.popY.v - this.jumpY;
      const h = this.rig.head;
      if (Math.hypot(px - h.cx, py - h.cy) < h.r * 1.25 && py < this.rig.neck[1]) return 'head';
      if (px > this.bx && px < this.bx + this.BW && py > this.by && py < this.by + this.BH) return 'body';
      return null;
    }

    // ---------- 公開API ----------
    lookAt(x, y) { this.look = { x, y, t: performance.now() }; }
    setManual(m) { this.manual = m ? { yaw: m.yaw || 0, pitch: m.pitch || 0 } : null; this.lastInput = performance.now(); }
    talk(ms = 1500) { this.talkUntil = performance.now() + ms; }
    // 表情を固定表示（素材フォルダの「役割名」。null で解除）。例: setExpression('笑顔')
    setExpression(name) { this.expr = name; this._fixedExpr = !!name; }
    // ポーズの絵に一時的に差し替える（その絵が無ければ何もしない）。ms を省略すると 1.2 秒
    pose(name, ms = 1200) {
      if (!this.byName || !this.byName['pose:' + name]) return false;
      this.poseName = name; clearTimeout(this._poseT);
      this._poseT = setTimeout(() => { if (this.poseName === name) this.poseName = null; }, ms);
      return true;
    }
    // 反応に合わせて表情を一瞬だけ出す（その表情の絵が無ければ何もしない。setExpression で固定中は邪魔しない）
    _flash(name, ms) {
      if (this._fixedExpr || !this.byName[name + ':face']) return;
      this.expr = name; clearTimeout(this._flashT);
      this._flashT = setTimeout(() => { if (!this._fixedExpr && this.expr === name) this.expr = null; }, ms);
    }

    react(type) {
      const S = this.S;
      this.lastInput = performance.now();
      switch (type) {
        case 'surprise':
          S.squash.kick(-3); this._hop(260); S.armR.kick(-2.2); S.armL.kick(-2.5); S.wide.t = 1; S.brow.t = 1; S.mouth.t = 0.7; this.open = 1; this.blinkPhase = -1;
          S.hairY.kick(40); this._particle('!', 0.78, 0.0, '#ff5a7a'); this._flash('驚き', 900);
          setTimeout(() => { S.wide.t = 0; S.brow.t = 0; S.mouth.t = 0; this._blink(); }, 700);
          break;
        case 'happy':
          S.squash.kick(-2.2); this._hop(200); S.roll.kick(rand(-1, 1) > 0 ? 1.2 : -1.2); S.armR.kick(-1.4); S.armL.kick(1.8); S.hip.kick(rand(-40, 40));
          this._happyEyes(1000); S.mouth.t = 0.55; this._hearts(2);
          setTimeout(() => { S.mouth.t = 0; }, 900);
          break;
        case 'shy':
          S.blush.t = 1; this._happyEyes(1400); this._flash('照れ', 1900); S.yaw.t = -0.6; S.pitch.t = -0.35; S.roll.t = -0.08; S.eyeX.t = -0.8;
          this._lookAway = performance.now() + 1700;
          setTimeout(() => { S.blush.t = 0.3; }, 1800);
          break;
        case 'nod':
          S.pitch.kick(-5); setTimeout(() => S.pitch.kick(-4), 280);
          break;
        case 'spin':
          if (this.mood === 'spin') return;
          if (this.byName.spin && this.useSpinFrames) {   // 回転コマ（動画素材）は既定では使わない
            this.mood = 'spin'; this.spinT = 0; this._hop(320); S.squash.kick(-2.4); S.hairY.kick(40);
            break;
          }
          // くるっ：今のパーツだけで「ぴょんと跳ねて体をひねる」
          this.mood = 'spin'; this._hop(320); S.squash.kick(-2.4);
          S.yaw.t = 1; S.bodyYaw.t = 1; S.roll.t = 0.08; S.hip.kick(-60); S.armL.kick(-2);
          setTimeout(() => { S.yaw.t = -1; S.bodyYaw.t = -1; S.roll.t = -0.08; S.hip.kick(90); S.skirt.kick(120); S.hairF.kick(80); }, 200);
          setTimeout(() => { S.yaw.t = 0; S.bodyYaw.t = 0; S.roll.t = 0; this._happyEyes(500); }, 430);
          setTimeout(() => { this.mood = 'idle'; }, 750);
          break;
      }
    }

    popAt(target, { hold = 1800, peek = 0.55 } = {}) {
      if (this.mood === 'pop') return;
      const rc = target.getBoundingClientRect();
      const s = this.scale, w = this.BW * s, h = this.BH * s;
      this._home = { parent: this.parentNode, next: this.nextSibling, style: this.getAttribute('style') };
      const clip = document.createElement('div');
      const extra = this.padTop * s, side = this.padX * s;
      const cx = rc.left + rc.width * rand(0.3, 0.7);
      Object.assign(clip.style, { position: 'fixed', left: (cx - w / 2 - side) + 'px', top: (rc.top - h - extra) + 'px',
        width: (w + side * 2) + 'px', height: (h + extra) + 'px', overflow: 'hidden', zIndex: 9999, pointerEvents: 'none' });
      document.body.appendChild(clip); clip.appendChild(this);
      Object.assign(this.style, { position: 'absolute', left: side + 'px', top: extra + 'px', pointerEvents: 'auto' });
      this.mood = 'pop';
      const S = this.S;
      S.popY.set(this.BH * 1.02); S.popY.t = this.BH * (1 - peek); S.popY.kick(-this.BH * 1.2);
      S.squash.kick(2.5); S.hairY.kick(-60); S.roll.t = rand(-1, 1) > 0 ? 0.14 : -0.14;
      this.lookAt(window.innerWidth / 2, window.innerHeight * 0.75);
      setTimeout(() => { this._blink(); S.mouth.t = 0.35; this._particle('♪', 0.8, 0.05, '#b784ff'); }, 350);
      setTimeout(() => { S.roll.t = 0; S.mouth.t = 0; }, 950);
      clearTimeout(this._popTimer);
      this._popTimer = setTimeout(() => {
        S.popY.t = this.BH * 1.05; S.squash.kick(-1.5);
        setTimeout(() => {
          const home = this._home;
          if (home.next) home.parent.insertBefore(this, home.next); else home.parent.appendChild(this);
          if (home.style == null) this.removeAttribute('style'); else this.setAttribute('style', home.style);
          this._layout(); clip.remove(); S.popY.set(0); this.mood = 'idle';
        }, 450);
      }, hold);
    }

    // ---------- 内部動作 ----------
    _hop(v) { if (this.jumpY >= -0.5) { this.jumpV = -v; this.S.hairY.kick(v * 0.25); } }
    _blink(double = Math.random() < 0.2) { if (this.blinkPhase < 0) { this.blinkPhase = 0; this._double = double; } }
    _happyEyes(ms) {
      this.happyEye = 1; this.lidHold = 1;
      clearTimeout(this._happyTimer);
      this._happyTimer = setTimeout(() => { this.lidHold = 0; setTimeout(() => { if (!this.lidHold) this.happyEye = 0; }, 250); }, ms);
    }
    _petting(e) {
      const S = this.S;
      if (!this.pet.active) { this.pet.active = true; this.mood = 'pet'; this.happyEye = 1; this.lidHold = 1; }
      S.blush.t = 1; S.mouth.t = 0.2;
      const rc = this.getBoundingClientRect();
      const dx = ((e.clientX - rc.left) / this.scale + this.bx - this.rig.head.cx) / this.rig.head.r;
      S.headX.t = clamp(dx * 6, -7, 7); S.roll.t = clamp(dx * 0.12, -0.14, 0.14); S.pitch.t = -0.15;
      S.squash.t = 0.02; S.hip.t = clamp(dx * 4, -5, 5); S.armR.t = 0.04;
      const now = performance.now();
      if (now - this.pet.heartT > 380) { this.pet.heartT = now; this._hearts(1); }
      clearTimeout(this._petEnd); this._petEnd = setTimeout(() => this._endPet(), 700);
    }
    _endPet() {
      if (!this.pet.active) return;
      const S = this.S;
      this.pet.active = false; this.pet.dist = 0;
      S.headX.t = 0; S.squash.t = 0; S.mouth.t = 0; S.roll.t = -0.08; S.hip.t = 0; S.armR.t = -0.05;
      setTimeout(() => { S.armR.t = 0; }, 2000);
      this.lidHold = 0; setTimeout(() => { if (!this.lidHold) this.happyEye = 0; }, 200);
      // 照れて目をそらす
      S.yaw.t = -0.55; S.pitch.t = -0.3; S.eyeX.t = -0.9; S.eyeY.t = 0.4;
      this._lookAway = performance.now() + 1800; this.look = null;
      S.blush.t = 0.65;
      setTimeout(() => { S.blush.t = 0; S.roll.t = 0; this.mood = 'idle'; }, 2600);
    }
    _wake(startle) {
      this.mood = 'idle'; this.lidHold = 0; this.breathRate = 1;
      Object.assign(this.S.pitch, { t: 0 }); this.S.roll.t = 0; this.S.lean.t = 0;
      if (startle) this.react('surprise');
    }

    _idle(dt) {
      const S = this.S;
      if (this.manual) return;
      const quiet = (performance.now() - this.lastInput) / 1000;
      if (this.mood === 'idle' && quiet > 25) {
        this.mood = 'sleep'; this.happyEye = 0; this.lidHold = 1; this.breathRate = 0.6;
        S.pitch.t = -0.45; S.roll.t = 0.1; S.yaw.t = 0; S.lean.t = 0.01;
      }
      if (this.mood === 'sleep') {
        this.zT -= dt;
        if (this.zT < 0) { this.zT = 2.2; this._particle('z', 0.72, 0.06, '#8aa0ff', true); }
        if (Math.random() < dt * 0.15) { S.pitch.kick(-3); S.roll.kick(0.3); }
        return;
      }
      if (this.mood !== 'idle') return;
      this.idleT -= dt;
      if (this.idleT > 0) return;
      this.idleT = rand(2.5, 5.5);
      if (this.look && performance.now() - this.look.t < 3500) return;
      const back = () => { if (this.mood === 'idle' && !this.look) { S.yaw.t = 0; S.pitch.t = 0; S.eyeX.t = 0; S.eyeY.t = 0; S.roll.t = 0; this.lidHold = 0; } };
      const p = Math.random();
      if (p < 0.28) {                               // きょろきょろ（目が先、顔があと）
        const yx = rand(-0.8, 0.8), yy = rand(-0.3, 0.4);
        S.eyeX.t = Math.sign(yx); S.eyeY.t = -yy;
        setTimeout(() => { S.yaw.t = yx; S.pitch.t = yy; }, 140);
        setTimeout(back, rand(1300, 2300));
      } else if (p < 0.46) {                        // 首かしげ
        S.roll.t = rand(-1, 1) > 0 ? 0.13 : -0.11; S.eyeX.t = rand(-0.4, 0.4);
        setTimeout(back, rand(1200, 2000));
      } else if (p < 0.64) {                        // スマホをちら見（右手側・伏し目）
        S.eyeX.t = -0.7; S.eyeY.t = 0.8;
        setTimeout(() => { S.yaw.t = -0.35; S.pitch.t = -0.45; this.lidHold = 0.35; S.armR.t = -0.07; }, 120);
        setTimeout(() => { back(); S.armR.t = 0; this._blink(false); }, rand(1800, 2800));
      } else if (p < 0.72) {                        // 重心移動
        const side = rand(-1, 1) > 0 ? 1 : -1;
        S.hip.t = side * rand(4, 7); S.lean.t = -side * 0.01; S.bodyYaw.t = side * rand(0.2, 0.5); S.roll.t = -side * 0.05;
        setTimeout(() => { S.hip.t = 0; S.lean.t = 0; S.bodyYaw.t = 0; S.roll.t = 0; }, rand(1600, 2600));
      } else if (p < 0.8) {                         // ヘッドホンの音楽にノる
        this.grooveUntil = performance.now() + rand(2800, 4200);
        this._particle('♪', 0.82, 0.04, '#b784ff');
      } else if (p < 0.88) {                        // のび
        S.squash.t = -0.03; S.pitch.t = 0.3; setTimeout(() => { S.squash.t = 0.04; }, 350);
        setTimeout(() => { S.squash.t = 0; S.pitch.t = 0; }, 1100);
      } else {                                      // 小さく跳ねる
        S.squash.kick(-1.6); this._hop(140);
      }
    }

    _tick(now) {
      const dt = Math.min(0.05, (now - this._last) / 1000); this._last = now;
      if (document.hidden || !this.ready || (this._offscreen && this.mood !== 'pop')) return;
      this.t += dt;
      const S = this.S, r = this.rig;

      if (this.manual) {
        S.yaw.t = this.manual.yaw; S.pitch.t = this.manual.pitch;
        S.eyeX.t = this.manual.yaw * 0.6; S.eyeY.t = -this.manual.pitch * 0.6;
        S.bodyYaw.t = this.manual.yaw * 0.5; this.lastInput = now;
      } else if (this.look && now - this.look.t < 3500 && this.mood !== 'spin' && this.mood !== 'sleep' && !(this._lookAway > now)) {
        const rc = this.getBoundingClientRect(), s = this.scale;
        const hx = rc.left + (r.head.cx - this.bx) * s, hy = rc.top + (r.head.cy - this.by) * s;
        const dx = this.look.x - hx, dy = this.look.y - hy;
        const nx = clamp(dx / (Math.abs(dx) + 180), -1, 1), ny = clamp(dy / (Math.abs(dy) + 200), -1, 1);
        // 目が先に動き、顔と体があとから追いつく
        S.eyeX.t = clamp(nx * 1.5, -1, 1); S.eyeY.t = clamp(ny * 1.4, -1, 1);
        S.yaw.t = nx * 0.95; S.pitch.t = clamp(-ny * 0.9, -0.8, 0.8);
        S.bodyYaw.t = nx * 0.45;
        if (this.mood === 'idle' || this.mood === 'pop') { S.roll.t = clamp(nx * 0.05, -0.08, 0.08); S.lean.t = nx * 0.008; S.hip.t = nx * 3; }
      } else if (this.mood === 'idle' && this.look) {
        this.look = null; S.yaw.t = 0; S.pitch.t = 0; S.eyeX.t = 0; S.eyeY.t = 0; S.roll.t = 0; S.bodyYaw.t = 0; S.lean.t = 0; S.hip.t = 0;
      }
      // くるっ：約1秒で一周。最初と最後は少しゆっくり、前後は元の姿とふわっと入れ替える
      this.spinA = 0;
      if (this.spinT != null) {
        const SP = this.meta.spin, dur = 1.05;
        this.spinT += dt;
        const q = clamp(this.spinT / dur, 0, 1), e = q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2;
        this._setSpinFrame(Math.min(SP.frames - 1, Math.floor(e * SP.frames)));
        this.spinA = Math.min(1, q / 0.04, (1 - q) / 0.04);
        if (q >= 1) { this.spinT = null; this.mood = 'idle'; this._blink(); }
      }
      this._idle(dt);

      // まばたき
      if (this.blinkPhase < 0) {
        this.blinkT -= dt;
        if (this.blinkT < 0 && this.lidHold < 0.9) { this._blink(); this.blinkT = rand(2.2, 5.5); }
        if (this.blinkPhase < 0 && this.blinkPhase > -0.5) { this.blinkPhase += dt; if (this.blinkPhase >= 0) this.blinkPhase = 0; }
      }
      let blink = 0;
      if (this.blinkPhase >= 0) {
        this.blinkPhase += dt;
        const p = this.blinkPhase, c = 0.06, h = 0.05, o = 0.11;
        blink = p < c ? p / c : p < c + h ? 1 : p < c + h + o ? 1 - (p - c - h) / o : 0;
        if (p > c + h + o) { if (this._double) { this._double = false; this.blinkPhase = -0.08; } else this.blinkPhase = -1; }
      }
      // 下を向いただけでは目を細めない（半目の絵へ急に切り替わって不自然になるため）
      const closeT = Math.max(blink, this.lidHold);
      this._blinking = blink > 0; this._dt = dt;
      this.open += ((1 - closeT) - this.open) * Math.min(1, dt * (blink > 0 ? 60 : 14));

      // 口パク
      // 口パク：開く・閉じるを不規則な間隔で切り替える（アニメの口パクと同じ）
      if (this.talkUntil > now) {
        if (!(this._talkNext > now)) {
          this._talkOpen = !this._talkOpen;
          this._talkNext = now + (this._talkOpen ? rand(90, 170) : rand(60, 130)) + (Math.random() < 0.12 ? 220 : 0);
        }
        S.mouth.t = this._talkOpen ? 0.7 : 0;
      }
      else if (this._wasTalking) S.mouth.t = 0;
      this._wasTalking = this.talkUntil > now;

      // 音楽にノる：腰で横に揺れて、2拍ごとに頭でリズム
      if (this.grooveUntil > now && this.mood === 'idle') {
        const b = this.t * Math.PI * 2;
        S.hip.t = Math.sin(b * 0.9) * 5; S.roll.t = Math.sin(b * 0.9) * 0.06;
        S.pitch.t = -0.1 + 0.16 * Math.abs(Math.sin(b * 0.9)); S.armR.t = Math.sin(b * 1.8) * 0.03;
        this._grooving = true;
      } else if (this._grooving) { this._grooving = false; S.hip.t = 0; S.roll.t = 0; S.pitch.t = 0; S.armR.t = 0; }

      for (const k in S) S[k].step(dt);
      // スカートと左腕：体の横移動に遅れてついてくる
      const body = S.hip.v + S.lean.v * 300 + S.bodyYaw.v * 8;
      const bv = (body - (this.prevBody || 0)) / Math.max(dt, 1e-3); this.prevBody = body;
      S.skirt.vel -= bv * 0.6 * dt * 10; S.armL.vel -= bv * 0.006 * dt * 10;
      // 髪：頭の動きに遅れる
      const head = S.yaw.v * 30 + S.roll.v * 120 + S.headX.v + S.lean.v * 300 + S.bodyYaw.v * 8;
      const hv = (head - this.prevHead) / Math.max(dt, 1e-3); this.prevHead = head;
      S.hairF.vel -= hv * 0.55 * dt * 10; S.hairB.vel -= hv * 0.75 * dt * 10;
      if (this.jumpV !== 0 || this.jumpY < 0) {
        this.jumpV += 1400 * dt; this.jumpY += this.jumpV * dt;
        if (this.jumpY >= 0) { this.jumpY = 0; if (this.jumpV > 60) { S.squash.kick(-Math.min(3.5, this.jumpV / 120)); S.hairY.kick(this.jumpV * 0.18); S.armL.kick(this.jumpV * 0.004); } this.jumpV = 0; }
      }

      this._deform();
      this._draw();
      const air = clamp(-this.jumpY / 60, 0, 1);
      this.shadowEl.style.opacity = this.mood === 'pop' ? 0 : (1 - air * 0.5);
      this.shadowEl.style.transform = `translateX(-50%) scale(${(1 - air * 0.3) * Math.max(0.3, Math.abs(S.scaleX.v))}, ${1 - air * 0.3})`;
    }

    // ---------- 変形（この関数が Live2D でいう「デフォーマ」） ----------
    _deform() {
      const S = this.S, r = this.rig, P = this.pos, R0 = this.rest;
      const H = r.head, [fx, fy] = r.feet, [nkx, nky] = r.neck;
      const top = r.bounds[1], bodyH = fy - top;
      const yaw = clamp(S.yaw.v, -1.3, 1.3) * MAX_YAW, pitch = clamp(S.pitch.v, -1.3, 1.3) * MAX_PITCH;
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const roll = S.roll.v, cr = Math.cos(roll), sr = Math.sin(roll);
      const breath = Math.sin(this.t * Math.PI * 2 / 3.6 * this.breathRate);
      const squash = clamp(S.squash.v, -0.25, 0.25), sx = S.scaleX.v;
      const lean = S.lean.v, bodyYaw = S.bodyYaw.v;
      const lift = -this.jumpY - S.popY.v;
      const open = clamp(this.open, 0, 1), happy = this.happyEye;
      const eX = clamp(S.eyeX.v, -1, 1), eY = clamp(S.eyeY.v, -1, 1), wide = S.wide.v;
      const hairF = clamp(S.hairF.v, -14, 14), hairB = clamp(S.hairB.v, -16, 16), hairY = clamp(S.hairY.v, -10, 10);
      const mouth = clamp(S.mouth.v, 0, 1);
      // 首の位置での体の動き（頭はここに乗る）
      const neckH = (fy - nky) / bodyH;
      const neckBreath = breath * 1.8 * smooth(0.3, 0.7, neckH);
      const tc = this.tc, ts = this.ts;
      const hip = S.hip.v, skirt = clamp(S.skirt.v, -10, 10);
      const aR = S.armR.v + breath * 0.012, aL = S.armL.v - breath * 0.008;
      const neckYawShift = bodyYaw * 7 * neckH + hip;
      // 頭の変形（球として3D回転 → 首を支点に傾ける）。首パーツの上端もこれでついていく
      const headPt = (x, y, depth) => {
        const dx = x - H.cx, dy = y - H.cy;
        const zs = Math.sqrt(Math.max(0, 1 - (dx * dx + dy * dy) / (H.r * H.r)));
        const z = (depth >= 0 ? depth * (0.35 + 0.65 * zs) : depth * (0.7 + 0.3 * zs)) * H.r;
        const x1 = dx * cy + z * sy, z1 = -dx * sy + z * cy, y1 = dy * cp - z1 * sp;
        // 回転の中心は頭の中心より奥なので、頭全体も向いた方へ少し動く（上下は首から離れないよう控えめ）
        const hx = H.cx + x1 + sy * H.r * 0.32, hy = H.cy + y1 - sp * H.r * 0.08;
        const qx = hx - nkx, qy = hy - nky;
        return [nkx + qx * cr - qy * sr + S.headX.v + neckYawShift, nky + qx * sr + qy * cr + S.headY.v - neckBreath];
      };
      const neckAnchor = headPt(nkx, nky, 0.3);
      const yawN = clamp(S.yaw.v, -1, 1);

      // 表情パーツの選択：まぶたの開き具合で「半目」「目閉じ」の絵に切り替える（アニメのまばたき）
      const B = this.byName;
      let faceDec = this.expr && B[this.expr + ':face'] ? this.expr + ':face' : null, eyeDec = null;
      if (!faceDec && happy && open < 0.6 && B['目閉じ:face']) faceDec = '目閉じ:face';
      if (!faceDec && B['半目:eyes'] && B['目閉じ:eyes']) eyeDec = open < 0.3 ? '目閉じ:eyes' : open < 0.78 ? '半目:eyes' : null;
      // 表情の絵はふわっと切り替える（まばたき中だけは素早く）
      this.decA = this.decA || {};
      const rate = this._blinking ? 70 : 11, k = Math.min(1, (this._dt || 0.016) * rate);
      let eyeCover = 0, mouthCover = 0;
      for (const p of this.parts) if (p.expr && p.kind !== 'mouth') {
        const a = this.decA[p.name] = lerp(this.decA[p.name] || 0, (p.name === faceDec || p.name === eyeDec) ? 1 : 0, k);
        eyeCover = Math.max(eyeCover, a); if (p.kind === 'face') mouthCover = Math.max(mouthCover, a);
      }
      // 開いた口：「おしゃべり」の絵があればそれを使う（顔全体の表情が出ている間は使わない）
      const talkPart = B['おしゃべり:mouth'];
      const mA = talkPart && mouthCover < 0.5 ? smooth(0.26, 0.36, mouth) : 0;

      this.poseA = this.poseA || {};
      const kPose = Math.min(1, (this._dt || 0.016) * 16);
      for (const p of this.parts) {
        const isHead = p.group === 'head';
        const name = p.name;
        const eye = name.endsWith('-r') || name.endsWith('-l') ? this.eyeInfo[name.slice(-1)] : null;
        const isEyeBall = name.startsWith('eyewhite') || name.startsWith('irides');
        const isIris = name.startsWith('irides'), isLash = name.startsWith('eyelash'), isBrow = name.startsWith('eyebrow');
        const isHairF = name === 'front hair' || name === 'hair-shadow' || name === 'hairclips', isHairB = name === 'back hair' || name === 'headwear-back';
        for (let k = p.v0; k < p.v0 + p.vn; k++) {
          let x = R0[k * 2], y = R0[k * 2 + 1];
          if (p.spin || p.pose) {
            // 回転コマ・ポーズの絵は全身の動き（ジャンプ・伸び縮み・傾き）だけ受ける
          } else if (isHead) {
            // (1) 顔パーツのローカル変形（目・口）
            if (eye && (isEyeBall || isLash)) {
              // 顔の傾きに沿った座標（lx=目の並び方向, ly=顔の下方向）で変形して戻す
              const E = eye.e, lid = eye.lidL;
              let lx = (x - E.cx) * tc + (y - E.cy) * ts, ly = -(x - E.cx) * ts + (y - E.cy) * tc;
              if (isEyeBall) {
                ly *= 1 + wide * 0.12; lx *= 1 + wide * 0.08;         // 見開き
                if (isIris) { lx += eX * E.w * 0.2; ly += eY * E.h * 0.13; }
                ly = lid + (ly - lid) * open;                         // まぶたで閉じる
              } else {
                // まつ毛：閉じると線になって下りる。通常は ‿、笑い目は ∩
                const close = 1 - open;
                const sc = lerp(1, happy ? 0.38 : -0.42, close);
                ly = lerp(eye.lashL, lid, close) + (ly - eye.lashL) * sc - wide * E.h * 0.06;
                lx *= 1 + close * 0.06;
              }
              x = E.cx + lx * tc - ly * ts; y = E.cy + lx * ts + ly * tc;
            } else if (isBrow && eye) {
              const up = S.brow.v * eye.e.h * 0.18 - (1 - open) * happy * eye.e.h * 0.05;
              x += up * ts; y -= up * tc;                               // 顔の「上」方向へ
            } else if (name === 'mouth-open') {
              // 生成した口を顔の傾きに合わせて回し、開き具合で縦に伸縮
              const [mx, my] = this.mouthC;
              let lx = x - mx, ly = (y - my) * Math.max(0.05, mouth);
              x = mx + lx * tc - ly * ts; y = my + lx * ts + ly * tc;
            } else if (name === 'blush') {
              // 頬の斜線も、近い方の目を中心に傾ける
              const E = (x < (this.rig.eyes[0].cx + this.rig.eyes[1].cx) / 2 ? this.eyeInfo.r : this.eyeInfo.l).e;
              const dx0 = x - E.cx, dy0 = y - E.cy;
              x = E.cx + dx0 * tc - dy0 * ts; y = E.cy + dx0 * ts + dy0 * tc;
            }
            // (2) 髪の揺れ（根元から離れるほど大きく）
            if (isHairF || isHairB) {
              const below = smooth(r.hairRoot, r.hairRoot + (H.r * 2.2), y);
              const ahoge = smooth(r.hairRoot, H.top, y);           // アホ毛は逆向きに揺れる
              const side = smooth(0.3, 1.0, Math.abs(x - H.cx) / H.r);
              const amt = isHairF ? hairF : hairB;
              x += amt * (below * (0.5 + 0.5 * side)) - amt * ahoge * 0.6;
              y += Math.abs(amt) * below * 0.06 + hairY * below * 0.6 - hairY * ahoge * 0.4;
            }
            // イヤーカップ：カップ側を向くと奥へ回り込んで細く、反対を向くと正面に近づいて広く
            if (name === 'headphone-cup') {
              const f = 1 - 0.65 * Math.max(0, yawN) + 0.22 * Math.max(0, -yawN);
              x = p.x + (x - p.x) * f;
            }
            // (3)(4) 頭を球として3D回転し、首を支点に傾ける（奥行きで動く量が変わる＝立体感）
            [x, y] = headPt(x, y, p.depth);
          } else {
            // 首：上端はあごについていき、下端は体（えりの中）に残る
            if (name === 'neck') {
              const w = smooth(p.y + p.h, p.y + p.h * 0.15, y);
              x += (neckAnchor[0] - nkx) * w; y += (neckAnchor[1] - nky) * w;
            }
            // 腕：支点まわりに回す（スマホの手が上下、左腕がぶらぶら）
            const withR = name === 'handwear-r' || name === 'objects' || name === 'hand-front';   // 持ち物と指は右手と一緒に
            const piv = withR ? this.pivR : name === 'handwear-l' ? this.pivL : null;
            if (piv) {
              const a = withR ? aR : aL, ca = Math.cos(a), sa = Math.sin(a);
              const qx = x - piv[0], qy = y - piv[1];
              x = piv[0] + qx * ca - qy * sa; y = piv[1] + qx * sa + qy * ca;
            }
            // スカート：すそほど遅れて揺れる
            if (name === 'bottomwear' && this.skirtY) x += skirt * smooth(this.skirtY[0], this.skirtY[1], y);
            // 体：呼吸・体のひねり（手前のパーツほど大きく）
            const hh = (fy - y) / bodyH;
            x += hip * smooth(0.12, 0.45, hh);                         // 腰から上の重心移動（ひざで曲がる）
            const chest = smooth(0.25, 0.45, hh) * (1 - smooth(0.6, 0.75, hh));
            y -= breath * 1.8 * smooth(0.25, 0.7, hh);
            x = fx + (x - fx) * (1 + breath * 0.01 * chest);
            x += bodyYaw * 7 * hh * (1 + p.depth * 1.5);
          }
          // (5) 全身：伸び縮み・傾き（足元が支点）・左右反転（くるっ用）
          let rx = (x - fx) * (1 - squash * 0.55) * sx, ry = (fy - y) * (1 + squash);
          const hh2 = ry / bodyH, la = lean * (0.4 + 0.6 * clamp(hh2, 0, 1));
          const ox = rx * Math.cos(la) + ry * Math.sin(la), oy = -rx * Math.sin(la) + ry * Math.cos(la);
          P[k * 2] = fx + ox - this.bx + this.padX;
          P[k * 2 + 1] = fy - oy - lift - this.by + this.padTop;
        }
        // パーツの濃さ
        p.alpha = 1;                                                // 毎フレーム表示に戻してから、隠すものを決める
        if (name === 'mouth-open') p.alpha = talkPart ? 0 : smooth(0.08, 0.3, mouth);
        else if (name === 'mouth') p.alpha = talkPart ? 1 - mA : 1 - smooth(0.08, 0.3, mouth);
        else if (name === 'blush') p.alpha = clamp(S.blush.v, 0, 1);
        else if (isEyeBall) p.alpha = smooth(0.04, 0.2, open);
        if (p.spin) { p.alpha = this.spinA || 0; continue; }
        if (p.pose) { p.alpha = this.poseA[name] = lerp(this.poseA[name] || 0, name === 'pose:' + this.poseName ? 1 : 0, kPose); continue; }
        // 回転コマは上に重ねて濃さを変えるので、下のキャラは回転コマが完全に出ている間だけ消す（半透明の二重像を防ぐ）
        const under = (this.spinA || 0) >= 0.999 ? 0 : 1;
        p.alpha *= under;
        if (p.expr) p.alpha = (p.kind === 'mouth' ? mA : (this.decA[name] || 0)) * under;
        else if (isEyeBall || isLash || isBrow) p.alpha *= 1 - eyeCover;
        else if (name === 'mouth' || name === 'mouth-open' || name === 'nose') p.alpha *= 1 - mouthCover;
      }
    }

    _poseCut() {
      const PS = this.meta.poses; if (!PS) return null;
      let full = 0; for (const k in this.poseA) full = Math.max(full, this.poseA[k]);
      if (full < 0.999) return null;
      // 全身の伸び縮み・ジャンプを足元基準でかけた時の、境目の高さ（キャンバス座標）
      const S = this.S, [fx, fy] = this.rig.feet, squash = clamp(S.squash.v, -0.25, 0.25);
      const lift = -this.jumpY - S.popY.v;
      return fy - (fy - PS.keepFrom) * (1 + squash) - lift - this.by + this.padTop;
    }

    _setSpinFrame(i) {
      if (i === this._spinFrame) return;
      this._spinFrame = i;
      const p = this.byName.spin, SP = this.meta.spin, [AW, AH] = SP.atlas;
      const col = i % SP.cols, row = Math.floor(i / SP.cols);
      let k = p.v0 * 2;
      const gx = clamp(Math.ceil(p.w / 14), 1, 28), gy = clamp(Math.ceil(p.h / 14), 1, 28);
      for (let j = 0; j <= gy; j++) for (let q = 0; q <= gx; q++) {
        this.uvArr[k++] = (col + q / gx) * SP.cellW / AW;
        this.uvArr[k++] = (row + j / gy) * SP.cellH / AH;
      }
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, p.v0 * 8, this.uvArr.subarray(p.v0 * 2, (p.v0 + p.vn) * 2));
    }

    _draw() {
      const gl = this.gl, u = this.u;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.pos);
      gl.clearColor(0, 0, 0, 0); gl.clearStencil(0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      this._boundTex = -1;
      const cut = this._poseCut();
      if (cut !== null) {
        const k = this.canvas.height / this.CH;
        gl.scissor(0, 0, this.canvas.width, Math.max(0, Math.round((this.CH - cut) * k)));
      }
      for (const p of this.parts) {
        if (p.alpha <= 0.003) continue;
        const n = p.name;
        if (cut !== null) { if (p.pose) gl.disable(gl.SCISSOR_TEST); else gl.enable(gl.SCISSOR_TEST); }
        // 黒目は白目の内側だけに描く（ステンシル）
        if (n.startsWith('eyewhite')) {
          gl.enable(gl.STENCIL_TEST); gl.stencilFunc(gl.ALWAYS, n.endsWith('r') ? 1 : 2, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE); gl.uniform1f(u.uCut, 0.3);
        } else if (n.startsWith('irides')) {
          gl.enable(gl.STENCIL_TEST); gl.stencilFunc(gl.EQUAL, n.endsWith('r') ? 1 : 2, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP); gl.uniform1f(u.uCut, 0.0);
        } else if (n === 'face') {
          // 顔の範囲だけを記録（色は描かずに、不透明な所だけ）→ 前髪の影を顔の上だけに描くため
          if (p.tex !== this._boundTex) { gl.bindTexture(gl.TEXTURE_2D, this.tex[p.tex]); this._boundTex = p.tex; }
          gl.enable(gl.STENCIL_TEST); gl.stencilFunc(gl.ALWAYS, 3, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
          gl.colorMask(false, false, false, false); gl.uniform1f(u.uCut, 0.5); gl.uniform1f(u.uAlpha, 1);
          gl.drawElements(gl.TRIANGLES, p.in, gl.UNSIGNED_SHORT, p.i0 * 2);
          gl.colorMask(true, true, true, true); gl.disable(gl.STENCIL_TEST); gl.uniform1f(u.uCut, 0.0);
        } else if (n === 'hair-shadow') {
          gl.enable(gl.STENCIL_TEST); gl.stencilFunc(gl.EQUAL, 3, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP); gl.uniform1f(u.uCut, 0.0);
        } else { gl.disable(gl.STENCIL_TEST); gl.uniform1f(u.uCut, 0.0); }
        if (p.tex !== this._boundTex) { gl.bindTexture(gl.TEXTURE_2D, this.tex[p.tex]); this._boundTex = p.tex; }
        gl.uniform1f(u.uAlpha, p.alpha);
        gl.drawElements(gl.TRIANGLES, p.in, gl.UNSIGNED_SHORT, p.i0 * 2);
      }
      gl.disable(gl.STENCIL_TEST); gl.disable(gl.SCISSOR_TEST);
    }

    // ---------- エフェクト ----------
    _particle(text, fx, fy, color, drift = false) {
      const el = document.createElement('div');
      el.className = 'p'; el.textContent = text; el.style.color = color;
      const w = this.BW * this.scale, h = this.BH * this.scale;
      el.style.left = (fx * w) + 'px'; el.style.top = (fy * h - this.S.popY.v * this.scale) + 'px';
      el.style.fontSize = Math.max(12, h * 0.09) + 'px';
      el.style.textShadow = '0 1px 0 #fff, 0 0 4px #fff';
      this.fx.appendChild(el);
      const dx = drift ? 18 : rand(-6, 6);
      el.animate([
        { transform: 'translate(0,6px) scale(.4)', opacity: 0 },
        { transform: 'translate(0,-4px) scale(1.15)', opacity: 1, offset: 0.25 },
        { transform: `translate(${dx}px,-${h * 0.16}px) scale(1)`, opacity: 0 }
      ], { duration: drift ? 2000 : 900, easing: 'cubic-bezier(.2,.8,.3,1)' }).onfinish = () => el.remove();
    }
    _hearts(n) {
      for (let i = 0; i < n; i++) setTimeout(() => {
        const el = document.createElement('div'); el.className = 'p';
        const w = this.BW * this.scale, h = this.BH * this.scale, sz = h * rand(0.06, 0.09);
        el.innerHTML = `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24"><path fill="#ff7aa2" stroke="#fff" stroke-width="1.5" d="M12 21s-7.5-4.6-9.6-9.2C.9 8.6 2.9 4.5 6.7 4.5c2.2 0 3.6 1.2 5.3 3.1 1.7-1.9 3.1-3.1 5.3-3.1 3.8 0 5.8 4.1 4.3 7.3C19.5 16.4 12 21 12 21z"/></svg>`;
        el.style.left = (w * rand(0.35, 0.8)) + 'px'; el.style.top = (h * rand(0, 0.12) - this.S.popY.v * this.scale) + 'px';
        this.fx.appendChild(el);
        const dx = rand(-20, 20);
        el.animate([
          { transform: 'translate(0,0) scale(.2) rotate(-10deg)', opacity: 0 },
          { transform: 'translate(0,-6px) scale(1.1) rotate(0deg)', opacity: 1, offset: 0.2 },
          { transform: `translate(${dx}px,-${h * 0.2}px) scale(.9) rotate(${dx / 2}deg)`, opacity: 0 }
        ], { duration: 1200, easing: 'ease-out' }).onfinish = () => el.remove();
      }, i * 160);
    }
  }
  customElements.define('sd-puppet', SDPuppet);
})();
