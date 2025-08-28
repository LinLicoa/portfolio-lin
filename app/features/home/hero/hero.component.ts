import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BgInteractiveComponent } from '../bg-interactive/bg-interactive.component';

@Component({
  standalone: true, 
  selector: 'app-hero',
  imports: [RouterLink, BgInteractiveComponent],
  templateUrl: './hero.component.html',
  styleUrls: ['./hero.component.css']
})
export class HeroComponent {

}
