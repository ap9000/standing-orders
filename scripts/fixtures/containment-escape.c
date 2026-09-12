#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
static void pause_ms(void) { struct timespec t={0,20000000}; nanosleep(&t,0); }
int main(int argc,char **argv) {
  if(argc!=3) return 64;
  char writes[4096], ready[4096], release[4096];
  snprintf(writes,sizeof writes,"%s/writes",argv[1]);
  snprintf(ready,sizeof ready,"%s/ready",argv[1]);
  snprintf(release,sizeof release,"%s/release",argv[1]);
  pid_t middle=fork(); if(middle<0)return 65;
  if(middle==0) {
    if(setsid()<0)_exit(66);
    pid_t leaf=fork();if(leaf<0)_exit(67);if(leaf>0)_exit(0);

    FILE *r=fopen(ready,"w");if(!r)_exit(68);fprintf(r,"%d %d\n",getpid(),getpgrp());fclose(r);
    for(int i=0;i<1500 && access(release,F_OK)!=0;i++) {
      int f=open(writes,O_WRONLY|O_CREAT|O_APPEND,0600);if(f>=0){write(f,"x",1);close(f);}pause_ms();
    }
    _exit(0);
  }
  waitpid(middle,0,0);
  for(int i=0;i<250 && access(ready,F_OK)!=0;i++)pause_ms();
  if(strcmp(argv[2],"root-exit")==0)return 0;
  for(int i=0;i<1500 && access(release,F_OK)!=0;i++)pause_ms();
  return 0;
}
