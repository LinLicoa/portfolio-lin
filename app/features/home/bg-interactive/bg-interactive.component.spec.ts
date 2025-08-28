import { ComponentFixture, TestBed } from '@angular/core/testing';

import { BgInteractiveComponent } from './bg-interactive.component';

describe('BgInteractiveComponent', () => {
  let component: BgInteractiveComponent;
  let fixture: ComponentFixture<BgInteractiveComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BgInteractiveComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(BgInteractiveComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
