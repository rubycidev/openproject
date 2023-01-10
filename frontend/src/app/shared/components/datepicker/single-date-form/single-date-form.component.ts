// -- copyright
// OpenProject is an open source project management software.
// Copyright (C) 2012-2023 the OpenProject GmbH
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License version 3.
//
// OpenProject is a fork of ChiliProject, which is a fork of Redmine. The copyright follows:
// Copyright (C) 2006-2013 Jean-Philippe Lang
// Copyright (C) 2010-2013 the ChiliProject Team
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
//
// See COPYRIGHT and LICENSE files for more details.
//++

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  forwardRef,
  Injector,
  Input,
  Output,
  ViewChild,
  ViewEncapsulation,
} from '@angular/core';
import { I18nService } from 'core-app/core/i18n/i18n.service';
import { DatePicker } from 'core-app/shared/components/datepicker/datepicker';
import { HalResourceEditingService } from 'core-app/shared/components/fields/edit/services/hal-resource-editing.service';
import { ResourceChangeset } from 'core-app/shared/components/fields/changeset/resource-changeset';
import { ConfigurationService } from 'core-app/core/config/configuration.service';
import { TimezoneService } from 'core-app/core/datetime/timezone.service';
import { DayElement } from 'flatpickr/dist/types/instance';
import flatpickr from 'flatpickr';
import { debounce } from 'rxjs/operators';
import { activeFieldContainerClassName } from 'core-app/shared/components/fields/edit/edit-form/edit-form';
import {
  Subject,
  timer,
} from 'rxjs';
import { ApiV3Service } from 'core-app/core/apiv3/api-v3.service';
import { FormResource } from 'core-app/features/hal/resources/form-resource';
import { DateModalRelationsService } from 'core-app/shared/components/datepicker/services/date-modal-relations.service';
import { DateModalSchedulingService } from 'core-app/shared/components/datepicker/services/date-modal-scheduling.service';
import {
  mappedDate,
  onDayCreate,
  parseDate,
  setDates,
  validDate,
} from 'core-app/shared/components/datepicker/helpers/date-modal.helpers';
import { DeviceService } from 'core-app/core/browser/device.service';
import { UntilDestroyedMixin } from 'core-app/shared/helpers/angular/until-destroyed.mixin';
import { WorkPackageChangeset } from 'core-app/features/work-packages/components/wp-edit/work-package-changeset';

@Component({
  selector: 'op-single-date-form',
  templateUrl: './single-date-form.component.html',
  styleUrls: ['../styles/datepicker.modal.sass', '../styles/datepicker_mobile.modal.sass'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  providers: [
    DateModalSchedulingService,
    DateModalRelationsService,
  ],
})
export class OpSingleDateFormComponent extends UntilDestroyedMixin implements AfterViewInit {
  @Output('savedOrCancelled') savedOrCancelled = new EventEmitter();

  @Input('value') value = '';

  @ViewChild('modalContainer') modalContainer:ElementRef<HTMLElement>;

  text = {
    save: this.I18n.t('js.button_save'),
    cancel: this.I18n.t('js.button_cancel'),
    date: this.I18n.t('js.work_packages.properties.date'),
    placeholder: this.I18n.t('js.placeholders.default'),
    today: this.I18n.t('js.label_today'),
  };

  scheduleManually = false;

  ignoreNonWorkingDays = false;

  htmlId = '';

  date:string|null = null;

  dateChangedManually$ = new Subject<void>();

  private debounceDelay = 0; // will change after initial render

  private changeset:ResourceChangeset;

  private datePickerInstance:DatePicker;

  constructor(
    readonly configurationService:ConfigurationService,
    readonly apiV3Service:ApiV3Service,
    readonly cdRef:ChangeDetectorRef,
    readonly injector:Injector,
    readonly I18n:I18nService,
    readonly timezoneService:TimezoneService,
    readonly halEditing:HalResourceEditingService,
    readonly dateModalScheduling:DateModalSchedulingService,
    readonly dateModalRelations:DateModalRelationsService,
    readonly deviceService:DeviceService,
  ) {
    super();

    dateModalRelations.setChangeset(this.changeset as WorkPackageChangeset);
    dateModalScheduling.setChangeset(this.changeset as WorkPackageChangeset);
  }

  ngAfterViewInit():void {
    this
      .dateModalRelations
      .getMinimalDateFromPreceeding()
      .subscribe((date) => {
        this.initializeDatepicker(date);
      });

    this
      .dateChangedManually$
      .pipe(
        // Avoid that the manual changes are moved to the datepicker too early.
        // The debounce is chosen quite large on purpose to catch the following case:
        //   1. date is for example 2022-07-15. The user wants to set the day value  to the 19th.
        //   2. So he/she starts entering the finish date 2022-07-1 .
        //   3. This is already a valid date. Since it is before the date,the date would be changed automatically to the first without the debounce.
        //   4. The debounce gives the user enough time to type the last number "9" before the changes are converted to the datepicker and the start date would be affected.
        //
        // Debounce delay is 0 for initial display, and then set to 800
        debounce(() => timer(this.debounceDelay)),
      )
      .subscribe(() => {
        // set debounce delay to its real value
        this.debounceDelay = 800;

        // Always update the whole form to ensure that no values are lost/inconsistent
        this.updateDate(this.date);
      });
  }

  changeSchedulingMode():void {
    this.initializeDatepicker();
    this.cdRef.detectChanges();
  }

  changeNonWorkingDays():void {
    this.initializeDatepicker();

    // If we're single date, update the date
    if (!this.ignoreNonWorkingDays && this.date) {
      // Resent the current start and end dates so duration can be calculated again.
      // this.dateUpdates$.next(this.date);
    }

    this.cdRef.detectChanges();
  }

  save($event:Event):void {
    $event.preventDefault();
    // Apply the changed scheduling mode if any
    this.changeset.setValue('scheduleManually', this.scheduleManually);

    // Apply include NWD
    this.changeset.setValue('ignoreNonWorkingDays', this.ignoreNonWorkingDays);

    // Apply the dates if they could be changed
    if (this.dateModalScheduling.isSchedulable) {
      this.changeset.setValue('date', mappedDate(this.date));
    }

    this.savedOrCancelled.emit();
  }

  cancel():void {
    this.savedOrCancelled.emit();
  }

  updateDate(val:string|null):void {
    // Expected minimal format YYYY-M-D => 8 characters OR empty
    if (val !== null && (val.length >= 8 || val.length === 0)) {
      if (validDate(val) && this.datePickerInstance) {
        const dateValue = parseDate(val) || undefined;
        this.enforceManualChangesToDatepicker(dateValue);
      }
    }
  }

  setToday():void {
    const today = parseDate(new Date()) as Date;
    this.date = this.timezoneService.formattedISODate(today);
    this.enforceManualChangesToDatepicker(today);
  }

  // eslint-disable-next-line class-methods-use-this
  reposition(element:JQuery<HTMLElement>, target:JQuery<HTMLElement>):void {
    if (this.deviceService.isMobile) {
      return;
    }

    element.position({
      my: 'left top',
      at: 'left bottom',
      of: target,
      collision: 'flipfit',
    });
  }

  private initializeDatepicker(minimalDate?:Date|null) {
    this.datePickerInstance?.destroy();
    this.datePickerInstance = new DatePicker(
      this.injector,
      '#flatpickr-input',
      this.date || '',
      {
        mode: 'single',
        showMonths: this.deviceService.isMobile ? 1 : 2,
        inline: true,
        onReady: (_date:Date[], _datestr:string, instance:flatpickr.Instance) => {
          instance.calendarContainer.classList.add('op-datepicker-modal--flatpickr-instance');
          this.reposition(jQuery(this.modalContainer.nativeElement), jQuery(`.${activeFieldContainerClassName}`));
        },
        onChange: (dates:Date[]) => {
          if (dates.length > 0) {
            this.date = this.timezoneService.formattedISODate(dates[0]);
            this.enforceManualChangesToDatepicker(dates[0]);
          }

          this.cdRef.detectChanges();
        },
        onDayCreate: (dObj:Date[], dStr:string, fp:flatpickr.Instance, dayElem:DayElement) => {
          onDayCreate(
            dayElem,
            this.ignoreNonWorkingDays,
            this.datePickerInstance?.weekdaysService.isNonWorkingDay(dayElem.dateObj),
            minimalDate,
            this.dateModalScheduling.isDayDisabled(dayElem, minimalDate),
          );
        },
      },
      null,
    );
  }

  private enforceManualChangesToDatepicker(enforceDate?:Date) {
    const date = parseDate(this.date || '');
    setDates(date, this.datePickerInstance, enforceDate);
  }

  /**
   * Update the datepicker dates and properties from a form response
   * that includes derived/calculated values.
   *
   * @param form
   * @private
   */
  private updateDatesFromForm(form:FormResource):void {
    const payload = form.payload as { date:string, ignoreNonWorkingDays:boolean };

    this.date = payload.date;
    this.ignoreNonWorkingDays = payload.ignoreNonWorkingDays;

    const parsedDate = parseDate(payload.date) as Date;
    this.enforceManualChangesToDatepicker(parsedDate);
  }
}
