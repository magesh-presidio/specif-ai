import {
  IProject,
  IProjectMetadata,
  ISolutionResponseRequirementItem,
} from '../../model/interfaces/projects.interface';
import { Injectable, NgZone } from '@angular/core';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import {
  BulkReadFiles,
  BulkUpdateFiles,
  CreateFile,
  CreateProject,
  GetProjectFiles,
  GetProjectListAction,
  ReadFile,
  UpdateFile,
  FileExists,
  ArchiveFile,
  UpdateMetadata,
  ClearBRDPRDState,
  checkBPFileAssociations,
  ExportRequirementData,
} from './projects.actions';
import { AppSystemService } from '../../services/app-system/app-system.service';
import { NGXLogger } from 'ngx-logger';
import { SolutionService } from '../../services/solution-service/solution-service.service';
import { Router } from '@angular/router';
import { IList } from '../../model/interfaces/IList';
import { ToasterService } from 'src/app/services/toaster/toaster.service';
import {
  BP_FILE_KEYS,
  REQUIREMENT_DISPLAY_NAME_MAP,
  REQUIREMENT_TYPE,
  RequirementType,
} from 'src/app/constants/app.constants';
import { RequirementTypeEnum } from 'src/app/model/enum/requirement-type.enum';
import { RequirementExportService } from 'src/app/services/export/requirement-export.service';
import { RequirementIdService } from 'src/app/services/requirement-id.service';
import { Optional } from 'src/app/utils/types';
import { PROJECT_ERROR_MESSAGES } from 'src/app/constants/messages.constants';

export class ProjectStateModel {
  projects!: IProject[];
  currentProjectFiles!: { name: string; children: string[] }[];
  selectedFileContent!: any;
  selectedFileContents!: IList[];
  selectedProject!: string;
  metadata!: any;
  loadingProjectFiles!: boolean;
  fileExists!: boolean;
  bpAssociationStatus!: {
    isAssociated: boolean;
    bpIds: string[];
  };
  exportingData!: boolean;
}

@State<ProjectStateModel>({
  name: 'projects',
  defaults: {
    projects: [],
    currentProjectFiles: [],
    selectedFileContent: {},
    selectedProject: '',
    metadata: {},
    selectedFileContents: [],
    loadingProjectFiles: false,
    fileExists: false,
    bpAssociationStatus: {
      isAssociated: false,
      bpIds: [],
    },
    exportingData: false,
  },
})
@Injectable()
export class ProjectsState {
  constructor(
    private appSystemService: AppSystemService,
    private logger: NGXLogger,
    private solutionService: SolutionService,
    private router: Router,
    private toast: ToasterService,
    private requirementExportService: RequirementExportService,
    private requirementIdService: RequirementIdService,
    private ngZone: NgZone,
  ) {}

  @Selector()
  static getProjects(state: ProjectStateModel) {
    return state.projects;
  }

  @Selector()
  static loadingProjectFiles(state: ProjectStateModel) {
    return state.loadingProjectFiles;
  }

  @Selector()
  static getProjectsFolders(state: ProjectStateModel) {
    return state.currentProjectFiles;
  }

  @Selector()
  static getSelectedFileContent(state: ProjectStateModel) {
    return state.selectedFileContent;
  }

  @Selector()
  static getSelectedFileContents(state: ProjectStateModel) {
    return state.selectedFileContents;
  }

  @Selector()
  static getSelectedProject(state: ProjectStateModel) {
    return state.selectedProject;
  }

  @Selector()
  static getFileExists(state: ProjectStateModel) {
    return state.fileExists;
  }

  @Selector()
  static getMetadata(state: ProjectStateModel) {
    return state.metadata;
  }

  @Selector()
  static getBpAssociationStatus(state: ProjectStateModel) {
    return state.bpAssociationStatus;
  }

  @Selector()
  static exportingData(state: ProjectStateModel) {
    return state.exportingData;
  }


  @Action(GetProjectListAction)
  async getProjectList({
    getState,
    patchState,
  }: StateContext<ProjectStateModel>) {
    const projectList = (await this.appSystemService.getProjectList()) || [];
    const sortedProjectList = projectList.sort((a, b) => {
      return (
        new Date(b.metadata.createdAt).getTime() -
        new Date(a.metadata.createdAt).getTime()
      );
    });
    const state = getState();
    patchState({
      ...state,
      projects: sortedProjectList,
    });
  }

  @Action(CreateProject)
  async createProject(
    { getState, patchState }: StateContext<ProjectStateModel>,
    { projectName, metadata, isRetry }: CreateProject,
  ) {
    try {
      const state = getState();
      const projectExists = await this.appSystemService.fileExists(projectName);
      if (projectExists && !isRetry) {
        throw new Error(
          'Project already exists, please retry with another unique project name',
        );
      }

      await this.appSystemService.createProject(metadata, projectName);

      let projectList;
      if (isRetry) {
        projectList = state.projects.map((project) =>
          project.metadata.id === metadata.id
            ? { ...project, metadata: { ...metadata } }
            : project,
        );
      } else {
        projectList = [
          ...state.projects,
          {
            project: projectName,
            projectKey: metadata.jiraProjectKey,
            metadata: {
              ...metadata,
            },
          },
        ];
      }

      const sortedProjectList = projectList.sort(
        (a, b) =>
          new Date(b.metadata.createdAt).getTime() -
          new Date(a.metadata.createdAt).getTime(),
      );

      patchState({
        ...state,
        projects: sortedProjectList,
      });

      this.ngZone.run(() => {
        this.router.navigate([`apps/${metadata.id}`]);
      });

      const response = await this.generateSolution(metadata, projectName);
      const responseMap = {
        [REQUIREMENT_TYPE.BRD]: response?.brd?.length || 0,
        [REQUIREMENT_TYPE.PRD]: response?.prd?.length || 0,
        [REQUIREMENT_TYPE.UIR]: response?.uir?.length || 0,
        [REQUIREMENT_TYPE.NFR]: response?.nfr?.length || 0,
        [REQUIREMENT_TYPE.US]: 0,
        [REQUIREMENT_TYPE.TASK]: 0,
        [REQUIREMENT_TYPE.BP]: 0,
        [REQUIREMENT_TYPE.TC]: 0,
      };

      metadata = {
        ...metadata,
        isFailed: false,
        failureInfo: null,
        ...Object.entries(REQUIREMENT_TYPE).reduce(
          (acc, [_, type]) => ({
            ...acc,
            [type]: metadata.cleanSolution
              ? { count: 0 }
              : { ...metadata[type], count: responseMap[type] },
          }),
          {},
        ),
      };

      await this.appSystemService.createFileWithContent(
        `${projectName}/.metadata.json`,
        JSON.stringify(metadata, null, 2),
      );

      patchState({
        projects: this.getUpdatedProjectsList(getState(), metadata),
      });
    } catch (e) {
      const error =
        e instanceof Error
          ? e
          : new Error('Unknown error occurred while creating project');
      this.logger.error('Error creating project', error);

      const isProjectExistsError = error.message.includes(
        'Project already exists',
      );

      if (!isProjectExistsError) {
        const updatedMetadata = {
          ...metadata,
          isFailed: true,
          failureInfo: {
            timestamp: new Date().toISOString(),
            reason: error.message.includes('Aborted')
              ? PROJECT_ERROR_MESSAGES.PROJECT_CREATION_ABORTED
              : error.message,
          },
        };

        await this.appSystemService.createFileWithContent(
          `${projectName}/.metadata.json`,
          JSON.stringify(updatedMetadata, null, 2),
        );

        patchState({
          projects: this.getUpdatedProjectsList(getState(), updatedMetadata),
        });
      }

      throw error;
    }
  }

  private async generateSolution(metadata: any, projectName: string) {
    const response = await this.solutionService.generateDocumentsFromLLM({
      id: metadata.id,
      createReqt: metadata.createReqt,
      name: projectName,
      description: metadata.description,
      cleanSolution: metadata.cleanSolution,
      brdPreferences: {
        minCount: metadata.BRD.minCount,
        isEnabled: metadata.BRD.enabled,
      },
      prdPreferences: {
        minCount: metadata.PRD.minCount,
        isEnabled: metadata.PRD.enabled,
      },
      uirPreferences: {
        minCount: metadata.UIR.minCount,
        isEnabled: metadata.UIR.enabled,
      },
      nfrPreferences: {
        minCount: metadata.NFR.minCount,
        isEnabled: metadata.NFR.enabled,
      },
      mcpSettings: metadata.mcpSettings,
    });

    if (response && !metadata.cleanSolution) {
      response.brd?.forEach((brd) =>
        this.generateFiles(brd, projectName, 'BRD'),
      );
      response.prd?.forEach((prd) => {
        // since the IDs of requirements are padded (length 2) when saved to fs
        const updatedPRD = {
          ...prd,
          linkedBRDIds: prd['linkedBRDIds']
            ?.map((brdId) => {
              try {
                return `BRD${brdId.split('BRD')[1].padStart(2, '0')}`;
              } catch (error) {
                this.logger.error('Error padding the linked brd id', error);
                return null;
              }
            })
            .filter(Boolean),
        };

        this.generateFiles(updatedPRD, projectName, 'PRD');
        this.generatePRDFeatureFiles(projectName, 'PRD', prd['id']);
      });
      response.uir?.forEach((uir) =>
        this.generateFiles(uir, projectName, 'UIR'),
      );
      response.nfr?.forEach((nfr) =>
        this.generateFiles(nfr, projectName, 'NFR'),
      );
    }

    return response;
  }

  private getUpdatedProjectsList(
    state: ProjectStateModel,
    metadata: IProjectMetadata,
  ): IProject[] {
    const updatedProjects = state.projects.map((p) =>
      p.metadata.id === metadata.id ? { ...p, metadata } : p,
    );

    return updatedProjects.sort(
      (a, b) =>
        new Date(b.metadata.createdAt).getTime() -
        new Date(a.metadata.createdAt).getTime(),
    );
  }

  @Action(GetProjectFiles)
  async getProjectFiles(
    { getState, patchState }: StateContext<ProjectStateModel>,
    { projectId, filterString }: GetProjectFiles,
  ) {
    // Start loading
    patchState({ loadingProjectFiles: true });

    const state = getState();

    // Filter the projects to find the one with the matching projectId
    const project = state.projects.find((p) => p.metadata.id === projectId);

    if (!project) {
      this.logger.debug(`Project with id ${projectId} not found.`);
      patchState({ loadingProjectFiles: false });
      return;
    }

    // Define the folder order
    const folderOrder = ['solution', 'BRD', 'PRD', 'NFR', 'UIR', 'BP', 'TC']; // Update as needed

    try {
      const files = await this.appSystemService.getFolders(
        project.project,
        filterString,
      );

      // Sort the files according to the folder order
      const sortedFiles = files.sort(
        (a: { name: string }, b: { name: string }) => {
          const indexA = folderOrder.indexOf(a.name);
          const indexB = folderOrder.indexOf(b.name);

          return (
            (indexA === -1 ? Number.MAX_SAFE_INTEGER : indexA) -
            (indexB === -1 ? Number.MAX_SAFE_INTEGER : indexB)
          );
        },
      );

      await this.requirementIdService.syncRootRequirementCounters(
        project.project,
      );

      patchState({
        currentProjectFiles: sortedFiles,
        selectedProject: project.project,
        metadata: project.metadata,
        loadingProjectFiles: false,
      });
    } catch (error) {
      this.logger.error('Failed to fetch project files:', error);
      patchState({ loadingProjectFiles: false });
    }
  }

  @Action(checkBPFileAssociations)
  async checkBPFileAssociations(
    { getState, patchState }: StateContext<ProjectStateModel>,
    { folderName, fileName }: checkBPFileAssociations,
  ) {
    const state = getState();
    const bpFolder = state.currentProjectFiles.find(
      (f) => f.name === RequirementTypeEnum.BP,
    );

    if (!bpFolder) {
      patchState({
        bpAssociationStatus: { isAssociated: false, bpIds: [] },
      });
      return;
    }

    try {
      const associatedBpIds: string[] = [];

      for (const file of bpFolder.children) {
        const content = await this.appSystemService.readFile(
          `${state.selectedProject}/${RequirementTypeEnum.BP}/${file}`,
        );
        const parsedContent = JSON.parse(content);
        const key =
          folderName === RequirementTypeEnum.PRD
            ? BP_FILE_KEYS.PRD_KEY
            : BP_FILE_KEYS.BRD_KEY;
        const isReferenced = this.isFileReferenced(
          fileName,
          parsedContent,
          key,
        );

        if (isReferenced) associatedBpIds.push(file.split('-')[0]);
      }

      patchState({
        bpAssociationStatus: {
          isAssociated: associatedBpIds.length > 0,
          bpIds: associatedBpIds,
        },
      });
    } catch (error) {
      this.logger.error('Error checking file associations', {
        folderName,
        fileName,
        error,
      });
      throw error;
    }
  }

  private isFileReferenced(
    fileName: string,
    parsedContent: any,
    key: string,
  ): boolean {
    return (
      parsedContent[key]?.some(
        (entry: { fileName: string }) => entry.fileName === fileName,
      ) || false
    );
  }

  private generateFiles(
    document: ISolutionResponseRequirementItem,
    projectName: string,
    folderName: string,
  ): void {
    const fileNameParts = document['id'].split(folderName);
    const content: Optional<ISolutionResponseRequirementItem, 'id'> = {
      ...document,
    };
    delete content['id'];

    const fileName = `${folderName}${fileNameParts[1].padStart(2, '0')}-base.json`;
    const fileContent = JSON.stringify(content, null, 2);

    this.appSystemService
      .createFileWithContent(
        `${projectName}/${folderName}/${fileName}`,
        fileContent,
      )
      .then();
  }

  private generatePRDFeatureFiles(
    projectName: string,
    folderName: string,
    identifier: string,
  ) {
    const fileNameParts = identifier.split(folderName);
    const path = `${projectName}/${folderName}/${folderName}${fileNameParts[1].padStart(2, '0')}-feature.json`;
    this.appSystemService
      .createFileWithContent(`${path}`, JSON.stringify({ features: [] }))
      .then();
  }

  @Action(ReadFile)
  async fetchFile(
    { getState, patchState }: StateContext<ProjectStateModel>,
    { path }: ReadFile,
  ) {
    const state = getState();
    const response = await this.appSystemService.readFile(
      `${state.selectedProject}/${path}`,
    );
    const parsedContent = JSON.parse(response);
    this.logger.debug('portion of content read: ', response);

    patchState({
      ...state,
      selectedFileContent: parsedContent,
    });
  }

  @Action(BulkReadFiles)
  async readFilesInBulkManner(
    { getState, patchState }: StateContext<ProjectStateModel>,
    { key, filterString }: BulkReadFiles,
  ) {
    const state = getState();
    this.logger.debug('Bulk reading files:', key);

    const folder = state.currentProjectFiles.find(
      (f: { name: any }) => f.name === key,
    );

    if (!folder) {
      this.logger.error('Folder not found:', key);
      return;
    }

    const paths = folder.children.map(
      (child: any) => `${state.selectedProject}/${folder.name}/${child}`,
    );

    const fileContents = await Promise.all(
      paths.map(async (path: string) => {
        try {
          this.logger.debug('path ==>', path);
          const content = await this.appSystemService.readPortionOfFile(
            path,
            filterString,
          );
          const fileName = path.split('/').pop() || '';

          return { folderName: folder.name, fileName, content: content };
        } catch (error) {
          this.logger.error('Error reading file:', path, error);
          return null;
        }
      }),
    );

    const nonNullFileContents = fileContents.filter(
      (file): file is IList => file !== null,
    );

    patchState({
      selectedFileContents: nonNullFileContents,
    });
  }

  @Action(CreateFile)
  async createFile(
    { getState, patchState }: StateContext<ProjectStateModel>,
    { path, content, featureFile }: CreateFile,
  ) {
    const state = getState();
    this.logger.debug('Creating file:', path, content);
    const fileContent = JSON.stringify(content);

    const baseFileCount = await this.appSystemService.createNewFile(
      `${state.selectedProject}/${path}`,
      fileContent,
      featureFile,
      state.metadata?.[path]?.count || -1,
    );

    if (!featureFile) {
      const { updatedMetadataContent, updatedProjects } =
        await this.updateRequirementCounterMetadata(state, path, baseFileCount);

      patchState({
        projects: updatedProjects,
        metadata: updatedMetadataContent,
      });
    }
  }

  private async updateRequirementCounterMetadata(
    state: ProjectStateModel,
    path: string,
    baseFileCount: number,
  ) {
    const updatedMetadataContent = {
      ...state.metadata,
      [path]: {
        ...state.metadata[path],
        count: baseFileCount + 1,
      },
    };

    await this.appSystemService.createFileWithContent(
      `${state.selectedProject}/.metadata.json`,
      JSON.stringify(updatedMetadataContent),
    );

    const updatedProjects = state.projects.map((p) =>
      p.metadata.id === state.metadata.id
        ? { ...p, metadata: updatedMetadataContent }
        : p,
    );

    return { updatedMetadataContent, updatedProjects };
  }

  @Action(UpdateFile)
  async updateFile(
    { getState, patchState }: StateContext<ProjectStateModel>,
    { path, content }: UpdateFile,
  ) {
    const state = getState();

    this.logger.debug(content, 'contentraw');

    const fileContent = JSON.stringify(content, null, 2);

    this.logger.debug(fileContent, 'contentrawJson');

    await this.appSystemService.createFileWithContent(
      `${state.selectedProject}/${path}`,
      fileContent,
    );
    patchState({
      ...state,
      selectedFileContent: content,
    });
  }

  @Action(FileExists)
  async fileExists(
    { getState, patchState }: StateContext<ProjectStateModel>,
    { path }: FileExists,
  ) {
    const state = getState();
    const response = await this.appSystemService.fileExists(
      `${state.selectedProject}/${path}`,
    );
    this.logger.debug('File exists: ', response);

    patchState({
      ...state,
      fileExists: response,
    });
  }

  @Action(ArchiveFile)
  async archiveFile(
    { getState, patchState }: StateContext<ProjectStateModel>,
    { path }: ArchiveFile,
  ) {
    const state = getState();
    await this.appSystemService.archiveFile(`${state.selectedProject}/${path}`);
    patchState({
      ...state,
    });
  }

  @Action(UpdateMetadata)
  async updateMetadata(
    { getState, patchState }: StateContext<ProjectStateModel>,
    { projectId, newMetadata }: UpdateMetadata, // Assuming newMetadata contains the updates you want to apply
  ) {
    const state = getState();

    const project = state.projects.find((p) => p.metadata.id === projectId);
    if (!project) {
      this.logger.error(`Project with id ${projectId} not found.`);
      return;
    }

    const metadataFilePath = `${project.project}/.metadata.json`;

    try {
      const existingMetadataContent =
        await this.appSystemService.readFile(metadataFilePath);
      const existingMetadata = JSON.parse(existingMetadataContent);

      const updatedMetadata = { ...existingMetadata, ...newMetadata };

      const updatedFileContent = JSON.stringify(updatedMetadata, null, 2);

      await this.appSystemService.createFileWithContent(
        metadataFilePath,
        updatedFileContent,
      );

      const updatedProjects = state.projects.map((p) => {
        if (p.metadata.id === projectId) {
          return {
            ...p,
            metadata: updatedMetadata, // Update the project's metadata
          };
        }
        return p;
      });

      patchState({
        ...state,
        projects: updatedProjects,
        metadata: updatedMetadata,
      });

      this.logger.debug('Metadata updated successfully in both file and state');
    } catch (error) {
      this.logger.error('Failed to update metadata:', error);
    }
  }

  @Action(ClearBRDPRDState)
  clearBRDPRDState(ctx: StateContext<ProjectStateModel>) {
    ctx.patchState({
      selectedFileContents: [],
    });
  }

  @Action(BulkUpdateFiles)
  async bulkUpdateFiles(
    { getState }: StateContext<ProjectStateModel>,
    { updates }: BulkUpdateFiles,
  ) {
    const state = getState();

    const results = await Promise.allSettled(
      updates.map(async (update) => {
        const fileContent = JSON.stringify(update.content, null, 2);
        await this.appSystemService.createFileWithContent(
          `${state.selectedProject}/${update.path}`,
          fileContent,
        );
      }),
    );

    const failedReqIds: Array<string> = [];

    results.forEach((res, idx) => {
      if (res.status === 'rejected') {
        try {
          this.logger.error(
            `Error updating file at path : ${updates[idx].path} - reason : ${res.reason}`,
          );
          const reqId = updates[idx].path.split('/')[-1].split('-')[0];
          failedReqIds.push(reqId);
        } catch (error) {
          this.logger.error('Error handling failure of file update', error);
        }
      }
    });

    if (failedReqIds.length > 0) {
      this.toast.showError(
        `Failed to update ${failedReqIds.join(', ')} requirements`,
      );
    }
  }

  @Action(ExportRequirementData)
  async exportRequirementData(
    { patchState, getState }: StateContext<ProjectStateModel>,
    { requirementType, options }: ExportRequirementData,
  ) {
    try {
      patchState({ exportingData: true });
      this.toast.showInfo(
        `Exporting ${REQUIREMENT_DISPLAY_NAME_MAP[requirementType as RequirementType]} data`,
      );
      const state = getState();

      await this.requirementExportService.exportRequirementData(
        state.selectedFileContents,
        {
          ...options,
          projectName: state.selectedProject,
        },
        requirementType,
      );
      patchState({ exportingData: false });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Error in export:', { error, errorMessage });
      this.toast.showError(`Failed to export data: ${errorMessage}`);
      patchState({ exportingData: false });
    }
  }
}
