import {
  AfterViewInit, Component, ElementRef, OnDestroy, ViewChild,
  HostListener, inject, PLATFORM_ID
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

type P = { x:number; y:number; vx:number; vy:number; r:number };

@Component({
  standalone: true,
  selector: 'app-bg-interactive',
  templateUrl: './bg-interactive.component.html',
  styleUrls: ['./bg-interactive.component.css'],
})
export class BgInteractiveComponent implements AfterViewInit, OnDestroy {
  @ViewChild('c') canvasRef!: ElementRef<HTMLCanvasElement>;
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private ctx!: CanvasRenderingContext2D;
  private w = 0; private h = 0; private dpr = 1;
  private rafId: number | null = null;
  private ro: ResizeObserver | null = null;
  private time = 0;

  // Puntero (objetivo) y foco suavizado (lerp)
  private pointer = { x: 0, y: 0 };
  private focal   = { x: 0, y: 0 };
  private lerpSpeed = 0.09; // 0.05–0.18

  // Ruido/partículas 
  private grains: P[] = [];
  private grainCount = 0; 

  // --- Film grain (patrón repetido) ---
  private noiseTex!: HTMLCanvasElement;
  private noisePattern: CanvasPattern | null = null;
  
  // movimiento del grano
  private grainOffset = { x: 0, y: 0 };   // acumulado para desplazar el patrón
  private grainDrift  = { x: 12, y: 8 };  // px/seg (antes de escalar) → velocidad base
  private parallax    = 0.25;             // cuánto sigue al puntero (0–1)
  private grainRotate = 0;                // rotación sutil
  private rotateSpeed = 0.15;             // rad/seg (muy pequeño)
  
  // para calcular dt y parallax
  private lastT = 0;
  private prevFocal = { x: 0, y: 0 };
  
  private grainScale = 6;   // “grosor” del grano (2–4)
  private noiseAlpha = 0.22; // intensidad (0.12–0.22)
  
  // Contraste del ruido
  private noiseContrast = 2.0;   // 1.0 sin cambio, 1.4–2.0 más contraste
  private noiseBinarize = false; // true = “sal y pimienta” (muy notorio)
  
  private blockSize = 1;         // 1=normal, 2–4 = celdas más grandes


  ngAfterViewInit() {
    if (!this.isBrowser) return;

    const canvas = this.canvasRef.nativeElement;

    const resize = () => {
      // Medir el PADRE 
      const hostEl = canvas.parentElement ?? canvas;
      const hostRect = hostEl.getBoundingClientRect();
      const rect = canvas.getBoundingClientRect();

      const width  = (rect.width && rect.height) ? rect.width  : (hostRect.width  || window.innerWidth);
      const height = (rect.width && rect.height) ? rect.height : (hostRect.height || window.innerHeight);

      this.w = Math.max(1, width);
      this.h = Math.max(1, height);
      this.dpr = Math.min(2, window.devicePixelRatio || 1);

      canvas.width  = Math.floor(this.w * this.dpr);
      canvas.height = Math.floor(this.h * this.dpr);

      this.ctx = canvas.getContext('2d')!;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      // Posición inicial del foco
      this.pointer.x = this.focal.x = this.w * 0.55;
      this.pointer.y = this.focal.y = this.h * 0.35;

      // Partículas 
      this.initGrain();

      // Construir textura de ruido una vez
      if (!this.noisePattern) this.buildNoiseTexture(128);

      this.drawFrame(0);
    };

    // Primer dibujo
    resize();

    // Observa el PADRE (define el tamaño cuando el canvas es absolute)
    this.ro = new ResizeObserver(resize);
    this.ro.observe(canvas.parentElement ?? canvas);

    // Bucle de animación
    const loop = (t: number) => {
      this.drawFrame(t);
      this.rafId = window.requestAnimationFrame(loop);
    };
    this.rafId = window.requestAnimationFrame(loop);

    // Pausar/reanudar si la pestaña no está visible (ahorra CPU)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.rafId != null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      } else if (document.visibilityState === 'visible' && this.rafId == null) {
        const loop2 = (t: number) => { this.drawFrame(t); this.rafId = requestAnimationFrame(loop2); };
        this.rafId = requestAnimationFrame(loop2);
      }
    }, { passive: true });
  }

  ngOnDestroy() {
    if (!this.isBrowser) return;
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.ro?.disconnect();
  }

  // Eventos globales para que el foco siempre siga al puntero
  @HostListener('document:mousemove', ['$event'])
  onMouse(e: MouseEvent){ this.updatePointer(e.clientX, e.clientY); }

  @HostListener('document:touchmove', ['$event'])
  onTouch(e: TouchEvent){
    const t = e.touches[0];
    if (t) this.updatePointer(t.clientX, t.clientY);
  }

  private updatePointer(cx: number, cy: number){
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    this.pointer.x = cx - rect.left;
    this.pointer.y = cy - rect.top;
  }

  // --- Partículas ---
  private initGrain(){
    if (this.grainCount <= 0) { this.grains = []; return; }
    const speed = 0.15;
    this.grains = Array.from({ length: this.grainCount }, () => ({
      x: Math.random() * this.w, y: Math.random() * this.h,
      vx: (Math.random() - 0.5) * speed, vy: (Math.random() - 0.5) * speed,
      r: Math.random() * 0.6 + 0.1
    }));
  }

  // --- Film grain: textura repetida ---
  private buildNoiseTexture(size = 128){
    this.noiseTex = document.createElement('canvas');
    this.noiseTex.width = this.noiseTex.height = size;
    const nctx = this.noiseTex.getContext('2d')!;
    const img = nctx.createImageData(size, size);
    const data = img.data;
  
    const contrast = this.noiseContrast;   // 1.0 = neutro
    const block = Math.max(1, this.blockSize);
  
    // Relleno por “bloques” para grano base más gordo si block>1
    for (let y = 0; y < size; y += block) {
      for (let x = 0; x < size; x += block) {
        // ruido base en [-0.5, 0.5]
        let r = Math.random() - 0.5;
        // aplicar contraste
        r = Math.max(-0.5, Math.min(0.5, r * contrast));
        // llevar a [0,255]
        let v = Math.round((r + 0.5) * 255);
  
        // binarizado opcional (muy notorio)
        if (this.noiseBinarize) v = v < 128 ? 70 : 200;
  
        // pintar bloque
        for (let by = 0; by < block; by++) {
          for (let bx = 0; bx < block; bx++) {
            const px = (y + by) * size + (x + bx);
            const i = px * 4;
            data[i] = data[i+1] = data[i+2] = v;
            data[i+3] = 255;
          }
        }
      }
    }
  
    nctx.putImageData(img, 0, 0);
    this.noisePattern = this.ctx.createPattern(this.noiseTex, 'repeat');
  }

  // --- Render frame ---
  private drawFrame(t: number){
    if (!this.ctx) return;
    this.time = t * 0.001;

    // Lerp hacia el puntero
    this.focal.x += (this.pointer.x - this.focal.x) * this.lerpSpeed;
    this.focal.y += (this.pointer.y - this.focal.y) * this.lerpSpeed;

    const ctx = this.ctx;

    // 1) Fondo base
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#1E1E1E';
    ctx.fillRect(0, 0, this.w, this.h);

    // 2) Gradiente radial (núcleo pequeño)
    const maxR = Math.max(this.w, this.h) * 0.9;
    const rg = ctx.createRadialGradient(this.focal.x, this.focal.y, 0, this.focal.x, this.focal.y, maxR);
    rg.addColorStop(0.00, '#F1EAE4');
    rg.addColorStop(0.01, '#F1EAE4'); // núcleo reducido
    rg.addColorStop(0.10, '#F257A2'); // rosa
    rg.addColorStop(0.35, '#322DBF'); // violeta
    rg.addColorStop(1.00, 'rgba(30,30,30,0)');
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, this.w, this.h);

    // 3) Film grain (patrón)
    // --- Film grain con movimiento (deriva + parallax + ligera rotación) ---
    if (this.noisePattern) {
      // dt en segundos
      const dt = this.lastT ? (t - this.lastT) / 1000 : 0;
      this.lastT = t;
    
      // deriva base (se mueve solo)
      this.grainOffset.x += this.grainDrift.x * dt;
      this.grainOffset.y += this.grainDrift.y * dt;
    
      // parallax según movimiento del foco (puntero suavizado)
      this.grainOffset.x += (this.focal.x - this.prevFocal.x) * this.parallax;
      this.grainOffset.y += (this.focal.y - this.prevFocal.y) * this.parallax;
    
      // rotación sutil
      this.grainRotate += this.rotateSpeed * dt;
    
      // limitar desplazamiento a tamaño de tile para evitar overflow
      const tile = this.noiseTex.width * this.grainScale; // en espacio “escalado”
      const mod = (v:number, m:number) => ((v % m) + m) % m;
      const offX = mod(this.grainOffset.x, tile);
      const offY = mod(this.grainOffset.y, tile);
    
      ctx.save();
      ctx.globalAlpha = this.noiseAlpha * (0.95 + 0.05 * Math.sin(this.time * 2.5)); // leve “flicker”
      ctx.globalCompositeOperation = 'overlay'; // prueba 'soft-light' o 'multiply'
    
      // aplicamos rotación muy sutil alrededor del centro
      ctx.translate(this.w * 0.5, this.h * 0.5);
      ctx.rotate(this.grainRotate * 0.05); // MUY suave
      ctx.translate(-this.w * 0.5, -this.h * 0.5);
    
      // pintamos el patrón escalado y desplazado
      ctx.translate(-offX, -offY);                  // desplazamiento animado
      ctx.scale(1 / this.grainScale, 1 / this.grainScale); // “grosor” del grano
      ctx.fillStyle = this.noisePattern;
      ctx.fillRect(0, 0, (this.w + tile) * this.grainScale, (this.h + tile) * this.grainScale);
    
      ctx.restore();
    }
    
    // al final del frame, guarda el foco para el parallax del siguiente
    this.prevFocal.x = this.focal.x;
    this.prevFocal.y = this.focal.y;

    // 4) Puntitos sutiles en el borde
    if (this.grains.length) {
      ctx.save();
      ctx.globalAlpha = 0.04;
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillStyle = 'white';
      for (const p of this.grains) {
        p.x += p.vx + Math.sin(this.time + p.y * 0.01) * 0.03;
        p.y += p.vy + Math.cos(this.time + p.x * 0.01) * 0.03;
        if (p.x < 0) p.x = this.w; if (p.x > this.w) p.x = 0;
        if (p.y < 0) p.y = this.h; if (p.y > this.h) p.y = 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // 5) Viñeta sutil
    ctx.globalCompositeOperation = 'source-over';
    const vg = ctx.createRadialGradient(
      this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.2,
      this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.95
    );
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, this.w, this.h);
  }
}
