import { Routes } from '@angular/router';
import { HomeComponent } from './features/home/home.component';

export const routes: Routes = [
  { path: '', component: HomeComponent }, // Home en la raíz
  { path: '**', redirectTo: '' },
];
